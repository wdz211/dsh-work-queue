/**
 * src/tools.mjs —— 六个工具工厂（+ health_check 的接线位）。
 *
 * 工具名与 spec §5 一一对应：work_open / work_report / work_list / work_get / work_close / work_attach。
 *
 * ── 三条必须守住的规矩（破了会静默出事）────────────────────────────────────
 *
 * 1. **每个工具都不许 throw**。工具抛异常会把整轮对话炸掉；这里统一 `try/catch` 转成
 *    `{ ok:false, code, message }`——那是**正常返回**，不是错误，模型能看见并自己纠。
 *
 * 2. **`output.schema` 必须登记每一个可能返回的键**。DSH 的工具输出是严格校验的，
 *    多返回一个没登记的字段整条结果会被拒收（模型那边表现为"工具没返回什么"）。
 *    所以每个 schema 的 properties 都与 execute 的返回结构一一对应，加字段要两边同时加。
 *
 * 3. **形状**：DSH 的 `tools.register()` 吃的是 `{ name, description, parameters, output, execute }`
 *    （照 plugins/dsh-automation-zone/src/tools.js 的实际写法）。另外把 `inputSchema` / `handler`
 *    作为**同一份引用**挂上去，接线层按任一种命名取用都能跑。
 *
 * 不依赖 sessionController：`exec.agent.id` 就是当前会话 id，够用了。少一个 inject
 * 就少一个启动期拿不到服务的失败面。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { REPORT_OUTCOMES, STAGE, STAGE_LABEL, compareTickets, deriveStage } from './stage.mjs'
// 账本整合（A1/A2）：复现模式的统计口径只有一处实现（lib/watchdog.mjs 的纯函数），
// 这里只是复用它，不另写一份——两份实现迟早会在"算几张单"这种细节上走散。
import {
  ATTENTION_MIN_OCCURRENCES,
  FIX_MIN_OCCURRENCES,
  collectProblemPatterns,
  isKebabCase,
} from '../lib/watchdog.mjs'

/** 工单来源（spec §3.2 的 kind 枚举）。 */
const KINDS = ['qq', 'automation', 'heartbeat', 'manual']

/** 优先级枚举。 */
const PRIORITIES = ['p0', 'p1', 'p2']

/** 全部 stage（work_list 的 stage 过滤白名单）。 */
const STAGES = Object.values(STAGE)

/** 标题上限（spec §5.1：≤200）。 */
const TITLE_MAX = 200

/** 关单结论上限（spec §5.5：≤500）。 */
const CONCLUSION_MAX = 500

/** work_list 默认返回条数（spec §5.3）。 */
const LIST_LIMIT_DEFAULT = 20

/** work_get 默认事件条数（spec §5.4）。 */
const GET_EVENTS_DEFAULT = 20

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 把任意异常压成统一失败结构。 */
function fail(err) {
  const code = err && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : 'IO_ERROR'
  const message = err instanceof Error ? err.message : String((err && err.message) || err || '未知错误')
  return { ok: false, code, message }
}

/** 参数对象兜底（模型偶尔会传 null）。 */
function argObj(args) {
  return args !== null && typeof args === 'object' && Array.isArray(args) === false ? args : {}
}

/** 取非空字符串；拿不到返回空串。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** 枚举取值：没给就用默认；给了但不合法返回 null（由调用方报 BAD_INPUT）。 */
function pickEnum(value, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return allowed.includes(value) ? value : null
}

/** 把数值参数压进 [min, max]，非数字用默认值。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 取当前会话 id（拿不到就是 null，不猜）。 */
function sessionIdOf(exec) {
  try {
    const id = exec && exec.agent ? exec.agent.id : undefined
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/** stage 的中文标签（渲染用）。 */
function labelOf(stage) {
  return STAGE_LABEL[stage] || String(stage || '未知')
}

/**
 * 现算某个 problemClass 的跨工单出现次数（账本整合 A1）。
 *
 * **只读**：走 `store.readEvents(null, 0)`（该路径连 mkdir 都不做），不碰 `readIndex`
 * ——那是写操作（索引过期会重建落盘）。读不到就返回 0 并把 `known:false` 交回去，
 * 让调用方能如实说"没算出来"，而不是编一个 0 次的结论。
 *
 * @returns {Promise<{occurrences:number, reports:number, fixWorthy:boolean,
 *                    needsAttention:boolean, known:boolean}>}
 */
async function patternOf(store, problemClass) {
  const empty = { occurrences: 0, reports: 0, fixWorthy: false, needsAttention: false, known: false }
  const name = str(problemClass).trim()
  if (!name || !store || typeof store.readEvents !== 'function') return empty
  try {
    const read = await store.readEvents(null, 0)
    if (!read || read.ok !== true || !Array.isArray(read.events)) return empty
    const hit = collectProblemPatterns(read.events).find((row) => row.problemClass === name)
    if (!hit) return { ...empty, known: true }
    return {
      occurrences: hit.occurrences,
      reports: hit.reports,
      fixWorthy: hit.fixWorthy,
      needsAttention: hit.needsAttention,
      known: true,
    }
  } catch {
    return empty
  }
}

/** 三段式的三段标题（格式沿用错题本：症状 / 原因 / 正确做法）。 */
const LESSON_SECTIONS = Object.freeze([
  /^#{1,6}\s*症状/m,
  /^#{1,6}\s*原因/m,
  /^#{1,6}\s*(?:正确做法|做法)/m,
])

/**
 * 判断 `work/<short>/lessons.md` 里是不是**三段式**内容（账本整合 A3.1）。
 *
 * 要求：三个标题都在，且至少有一行正文（不是标题、不是空行）。
 * 只有标题没正文的骨架不算——那种东西记进错题本只会变成噪声。
 */
function isThreeSectionLesson(text) {
  const body = str(text)
  if (!body.trim()) return false
  if (!LESSON_SECTIONS.every((re) => re.test(body))) return false
  return body.split(/\r?\n/).some((line) => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('#') && t !== '```'
  })
}

/**
 * 看这张单自己的工作目录里有没有可上账的 `lessons.md`。
 *
 * **只读**，且**只读 work/<short>/ 下的文件**——绝不看、绝不写 `.dsh-beta/lessons/`：
 * 那边是错题本自己的写者（spec §3.1 红线）。这里最多给出一个"去哪儿上账"的指针。
 *
 * @returns {{path:string, hint:string}} 没有可上账内容时两个字段都是空串
 */
function lessonSuggestionOf(store, id) {
  const none = { path: '', hint: '' }
  try {
    if (!store || typeof store.workDirOf !== 'function') return none
    const dir = store.workDirOf(id)
    if (typeof dir !== 'string' || !dir) return none
    const file = path.join(dir, 'lessons.md')
    if (!fs.existsSync(file)) return none
    if (!isThreeSectionLesson(fs.readFileSync(file, 'utf8'))) return none
    return {
      path: file,
      hint: '调 lessons_check 把它记进错题本（work-queue 不写 .dsh-beta/lessons/，落账走错题本自己的写者）',
    }
  } catch {
    return none
  }
}

/**
 * render 适配层。
 *
 * DSH 的 `output.render` 签名是 `(args, value) => contentParts`（automation-zone 就是这么写的）。
 * 这里既允许只吃 value（单参调用），也吃 (args, value)，并把字符串包成 `[{type:'text',text}]`——
 * 一套函数应付两种调用约定，接线层换写法也不会让工具卡片变空白。
 */
function renderer(fn) {
  return (...callArgs) => {
    const value = callArgs.length >= 2 ? callArgs[1] : callArgs[0]
    let out
    try {
      out = fn(value)
    } catch {
      out = '（渲染失败，请查看返回的原始字段）'
    }
    if (Array.isArray(out)) return out
    return [{ type: 'text', text: String(out) }]
  }
}

/** 所有工具共用的失败字段。 */
const FAIL_PROPS = {
  ok: { type: 'boolean', description: '是否成功。false 时看 code 与 message。' },
  code: {
    type: 'string',
    description: '失败代码：NOT_FOUND / BAD_INPUT / ALREADY_CLOSED / CORRUPT_TICKET / IO_ERROR / NOT_CONFIGURED。',
  },
  message: { type: 'string', description: '失败原因（人类可读）。' },
}

/** `work_list` 的一行（索引里存的就是这些字段）。 */
const TICKET_ROW = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    stage: { type: 'string', description: '派生状态，见 work_list 的说明。' },
    stageLabel: { type: 'string', description: 'stage 的中文标签。' },
    priority: { type: 'string' },
    owner: { type: 'object', description: '{ role, sessionId }' },
    ownerRole: { type: 'string' },
    ownerSessionId: { type: 'string' },
    updatedAt: { type: 'string' },
    closedAt: { type: 'string' },
    lastOutcome: { type: 'string', description: '最后一次报告的 outcome；没报过就是空字符串。' },
  },
  required: ['id', 'stage'],
}

/**
 * 把工厂的返回压成 DSH 认的工具对象。
 * `parameters` / `inputSchema` 与 `execute` / `handler` 是同一份引用（别名，不是拷贝）。
 */
function toolOf({ name, description, parameters, output, handler }) {
  return {
    name,
    description,
    parameters,
    inputSchema: parameters,
    output,
    execute: handler,
    handler,
  }
}

// ── work_open ─────────────────────────────────────────────────────────────

/**
 * `work_open`：开单。副作用 = 写 ticket + 追加 open 事件 + mkdir `work/<short>`。
 * @param {{store: object, log?: object, defaultRole?: string}} deps
 */
export function createWorkOpenTool(deps = {}) {
  const { store } = deps
  const defaultRole = typeof deps.defaultRole === 'string' && deps.defaultRole ? deps.defaultRole : 'lead'

  const handler = async (args, exec) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_open 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const title = str(a.title).trim()
      if (!title) return { ok: false, code: 'BAD_INPUT', message: 'title 必填：一句话说清这张单要交付什么' }

      const kind = pickEnum(a.kind, KINDS, 'manual')
      if (kind === null) return { ok: false, code: 'BAD_INPUT', message: `kind 必须是 ${KINDS.join(' / ')} 之一` }
      const priority = pickEnum(a.priority, PRIORITIES, 'p1')
      if (priority === null) return { ok: false, code: 'BAD_INPUT', message: `priority 必须是 ${PRIORITIES.join(' / ')} 之一` }

      const truncated = title.length > TITLE_MAX
      const role = str(a.role).trim() || defaultRole
      const sessionId = str(a.sessionId) || sessionIdOf(exec) || null
      const cwd = str(a.cwd).trim() || (typeof process !== 'undefined' && process.cwd ? process.cwd() : null)

      const created = await store.openTicket({
        title: truncated ? title.slice(0, TITLE_MAX) : title,
        desc: str(a.desc),
        kind,
        priority,
        owner: { role, sessionId },
        cwd,
      })
      if (created.ok !== true) return created

      const ticket = created.ticket
      const result = {
        ok: true,
        id: ticket.id,
        stage: deriveStage(ticket, [], Date.now()) || STAGE.QUEUED,
        dir: created.dir || store.workDirOf(ticket.id),
        title: ticket.title,
      }
      if (truncated) result.truncated = true
      return result
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_open',
    description: [
      '开一张工单：把「要做的事」从当前会话里拿出来落到磁盘上，这样换会话、过几天、换个执行器都还能查到它。',
      '什么时候用：①一件事要做超过一步、或要跨会话继续；②用户口述了一件要办的事；③你准备派给别人/别的会话做的事。',
      '开了单之后每推进一步就调 work_report；做完用 work_close 关掉（要写结论）。',
      '返回的 dir 是这张单专属的工作目录，中间产物放那里，别污染别处。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `一句话说清要做什么（必填，≤${TITLE_MAX} 字）` },
        desc: { type: 'string', description: '可选的详细说明（长文本放这里，不要塞进 title）' },
        kind: { type: 'string', enum: KINDS, description: '来源分类，默认 manual' },
        priority: { type: 'string', enum: PRIORITIES, description: '优先级，默认 p1。p0 只给真的急事' },
        cwd: { type: 'string', description: '可选：这张单关联的工作目录；不传用当前进程 cwd' },
        role: { type: 'string', description: '可选：责任人角色名；不传用默认' },
        sessionId: { type: 'string', description: '可选：绑定的会话 id；不传取调用者会话' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          id: { type: 'string', description: '新工单 id（形如 t-abc12345），后续操作都用它' },
          stage: { type: 'string', description: '刚开出来时的派生状态，通常是 queued' },
          dir: { type: 'string', description: '这张单专属的工作目录绝对路径' },
          title: { type: 'string' },
          truncated: { type: 'boolean', description: 'title 超长被截断时为 true' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `开单失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        const lines = [
          `已开工单 **${r.id}**（${labelOf(r.stage)}）`,
          `- 标题：${r.title ?? ''}`,
          `- 工作目录：${r.dir ?? '（未创建）'}`,
          '下一步：推进过程中用 work_report 记进展；收尾时 outcome=ready 必须带 evidence。',
        ]
        if (r.truncated === true) lines.push(`- 注意：标题超过 ${TITLE_MAX} 字，已截断`)
        return lines.join('\n')
      }),
    },
    handler,
  })
}

// ── 送进错题本 ────────────────────────────────────────────────────────────

const LESSON_KINDS = new Set(['error', 'bug', 'optimization', 'redundant-step', 'slow-path'])

/**
 * 与 `lessons/capture.mjs` 的 anchorOf 同一套规则：压掉路径、数字、引号、标点，
 * 只留能代表「这件事是什么」的骨架。整理阶段先按 anchor 机械聚类（零成本），
 * 同一个毛病换个文件名、换个行号也能聚到一起——「重复遇到就叠级」就靠它。
 */
function anchorOf(text) {
  let s = String(text ?? '').toLowerCase()
  s = s.replace(/[a-z]:\\[^\s，。；、）)]*/g, ' ')
  s = s.replace(/[~.]?[/\\][\w./\\-]+/g, ' ')
  s = s.replace(/0x[0-9a-f]+/g, ' ')
  s = s.replace(/\d+/g, ' ')
  s = s.replace(/[`'"“”‘’]/g, '')
  s = s.replace(/[^\u4e00-\u9fa5a-z]+/g, '')
  return s.slice(0, 24)
}

/**
 * 把工单侧的失败写进错题本的**输入口** `~/.dsh-beta/lessons/raw.jsonl`。
 *
 * ── 为什么这里破例写 lessons 目录 ──────────────────────────────────────
 * 原注释写的是「work-queue 绝不写 .dsh-beta/lessons/」，怕造出第二写者。
 * 那个担心针对的是 `ledger.json`——它是整份覆盖式写入，两个写者必然打架，
 * 所以只能由 consolidate 一个写者拥有。
 * 但 `raw.jsonl` 是 **append-only 的输入口**：每行一条独立原始记录，多写者
 * 各自追加不会互相破坏。等级、聚类、修复、归档仍然全部由 consolidate 独家负责。
 * append 不破坏单写者原则。
 *
 * ── 为什么必须自动写，而不是返回提示让模型去调 lessons_check ────────────
 * 靠「记得调」就是断点：工单一关、会话一结束，这条失败就永远进不了账。
 * 复发率是错题本唯一的验收标准，漏记一条就等于这个缺陷永远累加不到 L2/L3、
 * 永远等不到被修——那就退化成报警器了。
 *
 * 写入失败**绝不阻断 report**：账没记上是小事，报告丢了是大事。
 */
function captureToLessons({ kind, title, detail, session, lessonsDir }) {
  try {
    const text = str(title)
    if (!text) return false
    // 必须跟随调用方给的数据根目录（`<root>/workqueue` 的兄弟目录 `<root>/lessons`）。
    // **绝不能硬编码 `~/.dsh-beta`**：测试跑在临时目录时，硬编码会把测试数据写进真实账本
    // （2026-11-05 实际踩过：跑一次 node --test 往真实 raw.jsonl 灌了 28 条测试用例）。
    const dir =
      lessonsDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta'), 'lessons')
    fs.mkdirSync(dir, { recursive: true })
    const row = {
      at: new Date().toISOString(),
      type: 'issue',
      kind: LESSON_KINDS.has(kind) ? kind : 'error',
      title: text.slice(0, 300),
      detail: str(detail).slice(0, 2000),
      anchor: anchorOf(text),
      session: str(session) || null,
      seq: null,
      source: 'work-report',
    }
    fs.appendFileSync(path.join(dir, 'raw.jsonl'), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

// ── work_report ───────────────────────────────────────────────────────────

/**
 * `work_report`：记一次报告。
 * **ready 无 evidence 会被降级成 blocked 并返回 downgraded:true**（spec §1.5 硬闸）。
 * @param {{store: object, log?: object}} deps
 */
export function createWorkReportTool(deps = {}) {
  const { store } = deps

  const handler = async (args, exec) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_report 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const id = str(a.id).trim()
      if (!id) return { ok: false, code: 'BAD_INPUT', message: 'id 必填（work_open / work_list 返回值里的那个 id）' }
      if (!REPORT_OUTCOMES.includes(a.outcome)) {
        return { ok: false, code: 'BAD_INPUT', message: `outcome 必须是 ${REPORT_OUTCOMES.join(' / ')} 之一` }
      }

      // ── problemClass（账本整合 A1）──────────────────────────────────────
      // 只在 failed / blocked 下有意义：其它 outcome 传了**静默忽略**（spec §1「不报错」）。
      // 形状不对（不是 kebab-case）时才报 BAD_INPUT —— 分类不是自由文本，任人乱填会让
      // 「同一类问题出现几次」这个统计彻底失真。
      const classApplies = a.outcome === 'failed' || a.outcome === 'blocked'
      const rawClass = str(a.problemClass).trim()
      if (classApplies && rawClass && !isKebabCase(rawClass)) {
        return {
          ok: false,
          code: 'BAD_INPUT',
          message: 'problemClass 必须是 kebab-case（如 probe-false-positive / schema-mismatch）',
        }
      }

      const reported = await store.reportTicket(id, {
        outcome: a.outcome,
        evidence: str(a.evidence),
        note: str(a.note),
        problemClass: classApplies ? rawClass : '',
        // by 留空：store 会填工单的 owner.role（角色名比 sessionId 更适合写进事件）
      })
      if (reported.ok !== true) return reported

      const stage = deriveStage(reported.ticket, [], Date.now()) || STAGE.WORKING
      const result = {
        ok: true,
        id,
        stage,
        // 落盘实际记下的分类；被忽略（outcome 不是 failed/blocked）时是空串
        problemClass: typeof reported.problemClass === 'string' ? reported.problemClass : '',
        problemClassCount: 0,
        problemClassFixWorthy: false,
        problemClassNeedsAttention: false,
      }
      if (reported.downgraded === true) result.downgraded = true
      if (result.problemClass) {
        // 分级响应只"算次数"，不改任何数据（不自动修、不改优先级、不加寿命）
        const pat = await patternOf(store, result.problemClass)
        result.problemClassCount = pat.occurrences
        result.problemClassFixWorthy = pat.fixWorthy
        result.problemClassNeedsAttention = pat.needsAttention

        // ★ 送进错题本。这是闭环的入口，不是一句提示。
        // 不自动写就永远不会被聚类、累加、修复、归档——工单就只是个报警器。
        const t = reported.ticket && typeof reported.ticket === 'object' ? reported.ticket : {}
        const execObj = exec && typeof exec === 'object' ? exec : {}
        result.capturedToLessons = captureToLessons({
          // failed = 明确失败；blocked = 被卡住（多半是我判断错或前提不成立）
          kind: a.outcome === 'blocked' ? 'bug' : 'error',
          title: str(a.note) || str(t.title) || `工单 ${id} 报告 ${a.outcome}`,
          detail: [
            `工单 ${id}：${str(t.title) || '（无标题）'}`,
            `outcome=${a.outcome}${result.downgraded === true ? '（ready 因缺 evidence 被降级成 blocked）' : ''}`,
            `problemClass=${result.problemClass}（同类第 ${Math.max(1, pat.occurrences)} 次跨单出现）`,
            str(a.evidence) ? `证据：${str(a.evidence)}` : '证据：（未提供）',
            str(a.note) ? `备注：${str(a.note)}` : '',
          ].filter(Boolean).join('\n'),
          session: str(execObj.sessionId) || str(execObj.session) || '',
          // 跟随 store 的数据根：`<root>/workqueue` → `<root>/lessons`。
          // 测试把 dataDir 指到临时目录时这里自然跟着走，污染不了真实账本。
          lessonsDir:
            store && typeof store.dataDir === 'string' && store.dataDir
              ? path.join(path.dirname(store.dataDir), 'lessons')
              : '',
        })
      }
      return result
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_report',
    description: [
      '给工单记一次进展，并顺手更新它的状态。',
      'outcome 六选一：progress=在推进 / ready=做完了可以验收 / blocked=被卡住了 / failed=这次失败了 / ',
      'waiting-answer=在等用户回话 / waiting-review=在等审阅。',
      '⚠️ 报 ready **必须**带 evidence（可核验的证据：命令输出、文件路径、测试数字）。',
      '不带 evidence 的 ready 会被自动降级成 blocked —— 这不是防你，是防「自称做完了」这种话没有下文。',
      '连续 3 次 failed 会自动变成 stuck（卡死），那时候该找人而不是继续自动重试。',
      '可选 problemClass（kebab-case）：只给 failed/blocked 用来分类，跨工单统计同一类问题出现几次，',
      '≥2 次进看门狗的「该修」名单、≥3 次亮红灯。判不出来就别填——分类填错比不填更糟。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工单 id（必填）' },
        outcome: { type: 'string', enum: REPORT_OUTCOMES, description: '这次要记的状态（必填）' },
        evidence: { type: 'string', description: '可核验的证据。报 ready 时必填，缺失会被降级成 blocked' },
        note: { type: 'string', description: '可选备注：怎么卡的、下一步打算做什么' },
        problemClass: {
          type: 'string',
          description: '可选：这次失败/卡住的类别（kebab-case，如 probe-false-positive / encoding-mismatch / '
            + 'schema-mismatch / stale-comment / concurrent-write / timeout-too-tight）。只在 outcome 为 '
            + 'failed 或 blocked 时有效，其它 outcome 传了会被忽略。',
        },
      },
      required: ['id', 'outcome'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          id: { type: 'string' },
          stage: { type: 'string', description: '记完之后的派生状态' },
          downgraded: { type: 'boolean', description: 'true 表示 ready 因为缺 evidence 被降级成了 blocked' },
          problemClass: { type: 'string', description: '落盘的分类；没记（或被忽略）时是空串' },
          problemClassCount: {
            type: 'number',
            description: '同一 problemClass 出现在多少张不同工单上（含本次）；没记分类就是 0',
          },
          problemClassFixWorthy: { type: 'boolean', description: 'true = 已进「该修」名单（出现 ≥2 次）' },
          problemClassNeedsAttention: { type: 'boolean', description: 'true = 需要重视（出现 ≥3 次）' },
          capturedToLessons: {
            type: 'boolean',
            description: 'true = 这条失败已写进错题本 raw.jsonl，定时整理会按 anchor 聚成条目并累加等级',
          },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `记录失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        if (r.downgraded === true) {
          return [
            `工单 ${r.id} 已记为 **${labelOf(r.stage)}**（你的 ready 被降级成 blocked）`,
            '- 原因：outcome=ready 但 evidence 为空——**没证据的"做完了"不算做完**。',
            '- 下一步：把证据补上（改了哪些文件、跑了什么命令、输出是什么）再报一次 ready。',
          ].join('\n')
        }
        const lines = [`工单 ${r.id} 已记为 **${labelOf(r.stage)}**`]
        if (r.problemClass) {
          const n = Number(r.problemClassCount) || 0
          const verdict = r.problemClassNeedsAttention === true
            ? `⚠ 该类问题已出现在 ${n} 张单上（≥${ATTENTION_MIN_OCCURRENCES} 次）：需要重视`
            : r.problemClassFixWorthy === true
              ? `⚠ 该类问题已出现在 ${n} 张单上（≥${FIX_MIN_OCCURRENCES} 次）：进了「该修」名单`
              : `分类 \`${r.problemClass}\`（目前 ${n} 张单，只记录）`
          lines.push(`- ${verdict}`)
        }
        return lines.join('\n')
      }),
    },
    handler,
  })
}

// ── work_list ─────────────────────────────────────────────────────────────

/**
 * `work_list`：列工单（按 spec §4 排序）。
 * @param {{store: object, log?: object}} deps
 */
export function createWorkListTool(deps = {}) {
  const { store } = deps

  const handler = async (args) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_list 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const stageFilter = str(a.stage).trim()
      if (stageFilter && !STAGES.includes(stageFilter)) {
        return { ok: false, code: 'BAD_INPUT', message: `stage 必须是 ${STAGES.join(' / ')} 之一` }
      }
      const ownerFilter = str(a.owner).trim()
      const includeClosed = a.includeClosed === true
      const limit = clampInt(a.limit, LIST_LIMIT_DEFAULT, 1, 200)

      // 索引里已经带着派生好的 stage（store.rebuildIndex 会算），count 与实际文件数不符时会自动重建
      const indexed = await store.readIndex(Date.now())
      if (indexed.ok !== true) return indexed
      const rows = Array.isArray(indexed.index && indexed.index.tickets) ? indexed.index.tickets : []

      let list = includeClosed ? rows.slice() : rows.filter((row) => row.stage !== STAGE.CLOSED)
      if (stageFilter) list = list.filter((row) => row.stage === stageFilter)
      if (ownerFilter) {
        list = list.filter((row) => {
          const owner = row.owner && typeof row.owner === 'object' ? row.owner : {}
          return owner.role === ownerFilter || owner.sessionId === ownerFilter
        })
      }
      list.sort(compareTickets)

      const sliced = list.slice(0, limit)
      // owner 拍平成两个字符串字段（schema 里登记的是 ownerRole/ownerSessionId），并补 stageLabel
      const out = sliced.map((row) => {
        const owner = row.owner && typeof row.owner === 'object' ? row.owner : {}
        return {
          id: row.id,
          title: row.title,
          stage: row.stage,
          stageLabel: labelOf(row.stage),
          priority: row.priority,
          // 可空字段一律给空字符串，**不给 null**：DSH 的 output schema 是严格校验，
          // 声明了 type:'string' 的字段收到 null 会让整个结果被拒收
          // （实测报错：value.tickets[0].closedAt must be a string —— 一张未关闭的单
          //  就能把整个 work_list 打挂，这是踩过的坑，别再改回 null）。
          owner: { role: owner.role ?? '', sessionId: owner.sessionId ?? '' },
          ownerRole: owner.role ?? '',
          ownerSessionId: owner.sessionId ?? '',
          updatedAt: row.updatedAt,
          closedAt: row.closedAt ?? '',
          lastOutcome: row.lastOutcome ?? '',
        }
      })

      return {
        ok: true,
        count: out.length,
        tickets: out,
        corrupt: Array.isArray(indexed.index && indexed.index.corrupt) ? indexed.index.corrupt : [],
        total: list.length,
      }
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_list',
    description: [
      '查看工单列表（默认只看没关闭的），已按「该先管哪个」排好序：',
      'waiting-answer（等我回话）> waiting-review > stuck（连续失败3次）> blocked > failed > queued > working > idle（超2小时没动）> closed。',
      '同级内按 p0→p2、再按最近更新倒序。',
      '这是「状态离开会话」的入口：换了个会话、过了几天，用它能接上之前干到哪。',
      '读不出来的工单文件会被跳过并列在 corrupt 里，不会让整个列表失败。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: STAGES, description: '只看某个状态' },
        owner: { type: 'string', description: '只看某个责任人的单（匹配角色名或 sessionId）' },
        includeClosed: { type: 'boolean', description: '是否包含已关闭的（默认 false）' },
        limit: { type: 'integer', description: `最多返回几条，默认 ${LIST_LIMIT_DEFAULT}` },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          count: { type: 'number', description: '本次返回的条数（已截到 limit）' },
          total: { type: 'number', description: '过滤后的总数（截断前）' },
          tickets: { type: 'array', items: TICKET_ROW, description: '工单摘要，已排序' },
          corrupt: {
            type: 'array',
            items: { type: 'string' },
            description: '读不出来的工单文件 id（坏文件被跳过，不影响其余）',
          },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `查工单失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        const rows = Array.isArray(r.tickets) ? r.tickets : []
        const lines = []
        if (rows.length === 0) {
          lines.push('没有匹配的工单。')
        } else {
          lines.push(`工单 ${r.total ?? rows.length} 张（列出 ${rows.length} 张）：`)
          for (const row of rows) {
            const owner = row.ownerRole || row.ownerSessionId || '未认领'
            lines.push(`- ${row.id} [${labelOf(row.stage)}] ${row.title ?? ''}`
              + `（${row.priority ?? '-'} · ${owner} · ${row.lastOutcome ?? '尚无报告'}）`)
          }
        }
        if (Array.isArray(r.corrupt) && r.corrupt.length > 0) {
          lines.push(`⚠ 有 ${r.corrupt.length} 个工单文件损坏被跳过：${r.corrupt.join(', ')}`)
        }
        return lines.join('\n')
      }),
    },
    handler,
  })
}

// ── work_get ──────────────────────────────────────────────────────────────

/**
 * `work_get`：取一张单的正文 + 最近若干条事件。
 * @param {{store: object, log?: object}} deps
 */
export function createWorkGetTool(deps = {}) {
  const { store } = deps

  const handler = async (args) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_get 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const id = str(a.id).trim()
      if (!id) return { ok: false, code: 'BAD_INPUT', message: 'id 必填' }
      const events = clampInt(a.events, GET_EVENTS_DEFAULT, 1, 200)

      const got = await store.getTicket(id, { events })
      if (got.ok !== true) return got

      const ticket = got.ticket
      const evs = Array.isArray(got.events) ? got.events : []
      const stage = deriveStage(ticket, evs, Date.now()) || STAGE.QUEUED
      return {
        ok: true,
        ticket,
        stage,
        stageLabel: labelOf(stage),
        dir: store.workDirOf(ticket.id),
        events: evs,
      }
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_get',
    description:
      '看一张工单的全部细节，含最近若干条事件（谁开的、报过什么、换绑过没有、什么时候关的）。'
      + '换会话接手时先调它把上下文捞回来。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工单 id（必填）' },
        events: { type: 'integer', description: `返回最近几条事件，默认 ${GET_EVENTS_DEFAULT}` },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          ticket: { type: 'object', description: '工单全文（spec §3.2）' },
          stage: { type: 'string' },
          stageLabel: { type: 'string' },
          dir: { type: 'string', description: '这张单的工作目录' },
          events: { type: 'array', items: { type: 'object' }, description: '最近的事件，旧→新' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `查工单失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        const t = r.ticket || {}
        const lines = [
          `${t.id} [${r.stage}] ${t.title ?? ''}`,
          `- 优先级：${t.priority ?? '-'} · 来源：${t.kind ?? '-'}`,
          `- 认领：${t.owner?.role ?? '未认领'}${t.owner?.sessionId ? `（${t.owner.sessionId}）` : ''}`,
          `- 目录：${r.dir ?? '-'}`,
          `- 报告 ${t.reports ?? 0} 次，连续失败 ${t.failStreak ?? 0} 次`,
        ]
        if (t.lastReport) {
          lines.push(`- 最后报告：${t.lastReport.outcome}${t.lastReport.evidence ? ` · 证据：${t.lastReport.evidence}` : ''}`)
        }
        if (t.closedAt) lines.push(`- 已于 ${t.closedAt} 关闭：${t.closedReason ?? ''}`)
        const evs = Array.isArray(r.events) ? r.events : []
        lines.push(`- 最近事件 ${evs.length} 条：`)
        for (const ev of evs) lines.push(`  · ${ev.ts ?? ''} ${ev.type ?? ''}`)
        return lines.join('\n')
      }),
    },
    handler,
  })
}

// ── work_close ────────────────────────────────────────────────────────────

/**
 * `work_close`：关单（写 closedAt/closedReason + 追加 close 事件，**不删文件**）。
 * @param {{store: object, log?: object}} deps
 */
export function createWorkCloseTool(deps = {}) {
  const { store } = deps

  const handler = async (args, exec) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_close 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const id = str(a.id).trim()
      if (!id) return { ok: false, code: 'BAD_INPUT', message: 'id 必填' }
      const conclusion = str(a.conclusion).trim()
      if (!conclusion) return { ok: false, code: 'BAD_INPUT', message: 'conclusion 必填：关单要留下为什么关' }

      const closed = await store.closeTicket(id, { conclusion })
      if (closed.ok !== true) return closed

      // ── 账本整合 A3.1：只"指认"，不代写 ─────────────────────────────────
      // 只看这张单自己的 work/<short>/lessons.md；`.dsh-beta/lessons/` 一个字节都不碰
      // （那边是错题本的唯一写者）。关单是幂等的，所以已经关过的单也给同一个 suggestion。
      const suggestion = lessonSuggestionOf(store, id)

      const result = {
        ok: true,
        id,
        stage: STAGE.CLOSED,
        closedAt: closed.ticket ? str(closed.ticket.closedAt) : '',
        lessonSuggestion: suggestion,
      }
      if (closed.alreadyClosed === true) result.alreadyClosed = true
      return result
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_close',
    description: [
      '关掉一张工单。**必须写结论**——「为什么这件事算完了」比「它完成了」有用得多。',
      '关单不删文件：历史留着，事后能查为什么关的、谁关的。',
      '如果你把这次踩的坑写进了这张单自己的 lessons.md（三段式：症状/原因/正确做法），',
      '返回值里的 lessonSuggestion 会指给你看——**本插件不写错题本**，落账由你调 lessons_check 完成。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工单 id（必填）' },
        conclusion: { type: 'string', description: `关单结论（必填，≤${CONCLUSION_MAX} 字）：做成了什么、证据在哪、有没有遗留` },
      },
      required: ['id', 'conclusion'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          id: { type: 'string' },
          stage: { type: 'string' },
          closedAt: { type: 'string', description: '关闭时间；拿不到就是空串（绝不给 null）' },
          alreadyClosed: { type: 'boolean', description: '之前已经关过了（本次没重复写事件）' },
          lessonSuggestion: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'work/<short>/lessons.md 的绝对路径；没有可上账内容时为空串' },
              hint: { type: 'string', description: '下一步提示；没有可上账内容时为空串' },
            },
            required: ['path', 'hint'],
            description: '三段式 lessons.md 存在时给出的「去记错题本」提示；本插件绝不写 lessons 目录',
          },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `关单失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        if (r.alreadyClosed === true) return `${r.id} 之前已经关过了（本次没有重复写事件）`
        const lines = [`已关闭 ${r.id}（${r.closedAt ?? ''}）。文件保留，事后可以 work_get 查全过程。`]
        if (r.lessonSuggestion && r.lessonSuggestion.path) {
          lines.push(`📝 这张单留了可上账的经验：${r.lessonSuggestion.path}`)
          lines.push(`   ${r.lessonSuggestion.hint}`)
        }
        return lines.join('\n')
      }),
    },
    handler,
  })
}

// ── work_attach ───────────────────────────────────────────────────────────

/**
 * `work_attach`：换会话后把单重新绑到新 sessionId / cwd（**不动 stage**）。
 * @param {{store: object, log?: object}} deps
 */
export function createWorkAttachTool(deps = {}) {
  const { store } = deps

  const handler = async (args, exec) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_attach 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const id = str(a.id).trim()
      if (!id) return { ok: false, code: 'BAD_INPUT', message: 'id 必填' }

      const patch = {}
      const sessionId = str(a.sessionId) || sessionIdOf(exec)
      if (sessionId) patch.sessionId = sessionId
      if (a.cwd !== undefined && a.cwd !== null) patch.cwd = str(a.cwd)
      if (a.role !== undefined && a.role !== null) patch.role = str(a.role)
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          code: 'BAD_INPUT',
          message: '至少要给 sessionId / cwd / role 之一（或让调用者会话提供 sessionId）',
        }
      }

      const attached = await store.attachTicket(id, patch)
      if (attached.ok !== true) return attached

      const owner = attached.ticket.owner && typeof attached.ticket.owner === 'object' ? attached.ticket.owner : {}
      return {
        ok: true,
        id,
        owner: { role: owner.role ?? null, sessionId: owner.sessionId ?? null },
        ownerRole: owner.role ?? null,
        ownerSessionId: owner.sessionId ?? null,
        cwd: attached.ticket.cwd ?? null,
      }
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_attach',
    description: [
      '把工单换绑到另一个会话 / 目录 / 责任人。',
      '典型场景：你在 A 会话开的单，现在换到 B 会话继续做 —— 调它把 sessionId 改成 B，',
      '这张单就跟着你走了（工单本身不认会话，所以换会话不会丢掉它；attach 只是让「谁在负责」这个字段跟上）。',
      'attach **不动 stage**，也不重置 idle 计时：换绑不是进展。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工单 id（必填）' },
        sessionId: { type: 'string', description: '新会话 id；不传就用调用者会话，都没有才不传这个字段' },
        cwd: { type: 'string', description: '新的工作目录；不传就不改' },
        role: { type: 'string', description: '新的责任人角色名；不传就不改' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          id: { type: 'string' },
          owner: { type: 'object', description: '{ role, sessionId }' },
          ownerRole: { type: 'string' },
          ownerSessionId: { type: 'string' },
          cwd: { type: 'string' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `换绑失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        return `已换绑 ${r.id} → ${r.ownerRole ?? r.owner?.role ?? '(无)'}`
          + `${r.ownerSessionId ? `（${r.ownerSessionId}）` : ''} · 目录 ${r.cwd || '(无)'}`
      }),
    },
    handler,
  })
}

// ── work_link_lesson ──────────────────────────────────────────────────────

/**
 * `work_link_lesson`：在工单自己的事件流里留一条「这条单踩的坑记进了错题本某条」（A3.2）。
 *
 * 三个必须守住的边界：
 *   · **只写工单自己的 events.jsonl**（一个 ticketId 一条事件），不读不写 `.dsh-beta/lessons/`；
 *   · **幂等**：同一 (ticketId, entryId) 重复调用不重复追加，返回 `alreadyLinked:true`；
 *   · 关掉的单也能记（历史永续），但**不存在的单**要如实报 NOT_FOUND，别写一条孤儿事件。
 *
 * 检查与追加放在 `store.runExclusive(ticketId, ...)` 里串起来：并发的两次调用不会各追加一条
 * （串行链是 store 自己的机制，这里只是借用，没有新增任何锁或状态文件）。
 *
 * @param {{store: object, log?: object}} deps
 */
export function createWorkLinkLessonTool(deps = {}) {
  const { store } = deps

  const handler = async (args, exec) => {
    try {
      if (!store) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_link_lesson 缺少 store 依赖（插件装配有问题）' }
      const a = argObj(args)
      const ticketId = str(a.ticketId).trim()
      if (!ticketId) return { ok: false, code: 'BAD_INPUT', message: 'ticketId 必填（要关联的工单 id）' }
      const entryId = str(a.entryId).trim()
      if (!entryId) return { ok: false, code: 'BAD_INPUT', message: 'entryId 必填（错题本那条记录的 id）' }

      const ticket = await store.readTicket(ticketId)
      if (ticket.ok !== true) return ticket // NOT_FOUND 原样转出去

      if (typeof store.runExclusive !== 'function') {
        return { ok: false, code: 'NOT_CONFIGURED', message: 'store 没有 runExclusive，无法保证幂等（拒绝写下可能重复的事件）' }
      }
      const owner = ticket.ticket && ticket.ticket.owner && typeof ticket.ticket.owner === 'object'
        ? ticket.ticket.owner
        : {}
      const actor = str(owner.role) || str(owner.sessionId) || null
      const sessionId = sessionIdOf(exec) || str(owner.sessionId) || null

      const done = await store.runExclusive(ticketId, async () => {
        // 读一遍这张单的事件流：已经有同 entryId 的 lesson-linked 就当没事发生
        const read = await store.readEvents(ticketId, 0)
        if (!read || read.ok !== true || !Array.isArray(read.events)) {
          return {
            decision: 'error',
            code: (read && read.code) || 'IO_ERROR',
            message: (read && read.message) || '读不到这张单的事件流，无法确认幂等，已放弃追加',
          }
        }
        const already = read.events.some((ev) => ev && ev.type === 'lesson-linked' && str(ev.entryId) === entryId)
        if (already) return { decision: 'already' }

        const appended = await store.appendEvent({
          ts: new Date().toISOString(),
          ticketId,
          type: 'lesson-linked',
          entryId,
          by: actor,
          role: actor,
          sessionId,
          payload: { entryId },
        })
        if (!appended || appended.ok !== true) {
          return {
            decision: 'error',
            code: (appended && appended.code) || 'IO_ERROR',
            message: (appended && appended.message) || '追加事件失败',
          }
        }
        return { decision: 'appended' }
      })
      if (done.ok !== true) {
        return { ok: false, code: done.code || 'IO_ERROR', message: done.message || '串行执行失败' }
      }
      const decided = done.value && typeof done.value === 'object' ? done.value : {}
      if (decided.decision === 'error') {
        return { ok: false, code: decided.code || 'IO_ERROR', message: decided.message || '追加事件失败' }
      }
      if (decided.decision === 'already') {
        return { ok: true, ticketId, entryId, appended: false, alreadyLinked: true }
      }
      return { ok: true, ticketId, entryId, appended: true, alreadyLinked: false }
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_link_lesson',
    description: [
      '把「这张工单踩的坑」指到错题本里的某一条（entryId）上——单向指认，**各自写自己的文件**。',
      '只在工单自己的事件流里追加一条 lesson-linked 事件；不读、不写错题本目录（那边由它自己的写者管）。',
      '同一 (ticketId, entryId) 重复调用是幂等的：不会重复追加，返回 alreadyLinked=true。',
      '错题本那边若以后要回填 seenIn，由它自己在落账时做——本插件不代劳。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: '工单 id（必填）' },
        entryId: { type: 'string', description: '错题本那条记录的 id（必填，原样存，不解释）' },
      },
      required: ['ticketId', 'entryId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          ticketId: { type: 'string' },
          entryId: { type: 'string' },
          appended: { type: 'boolean', description: '本次是否真的追加了一条事件' },
          alreadyLinked: { type: 'boolean', description: 'true = 之前已经关联过（本次没重复追加）' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `关联失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        if (r.alreadyLinked === true) return `${r.ticketId} 之前已经关联过错题本条目 ${r.entryId}（没有重复追加）`
        return `已在 ${r.ticketId} 的事件流里记下 → 错题本条目 ${r.entryId}`
      }),
    },
    handler,
  })
}

// ── health_check（M4 的接线位；实现由 src/health.mjs 提供）──────────────────

/**
 * `health_check` 工具外壳。
 *
 * 探活逻辑**不在这里**——它在 `src/health.mjs`（同包另一个模块负责）。这里只做三件事：
 * 建参数表、把 `health.check()` 的结果压成登记过的字段、以及把异常吃成 `{ok:false}`。
 * `health` 没注入时返回 null（调用方跳过注册），不抛。
 *
 * @param {{health?: {check: Function}, log?: object}} deps
 */
export function createHealthCheckTool(deps = {}) {
  const health = deps && deps.health
  if (!health || typeof health.check !== 'function') return null

  const handler = async () => {
    try {
      const result = await health.check()
      if (!result || result.ok === false) {
        return { ok: false, code: (result && result.code) || 'HEALTH_FAILED', message: (result && result.message) || '自检失败' }
      }
      return {
        ok: true,
        critical: Number(result.critical) || 0,
        items: Array.isArray(result.items) ? result.items : [],
        reportPath: typeof result.reportPath === 'string' ? result.reportPath : '',
      }
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'health_check',
    description: [
      '跑一次系统健康自检：QQ 链路、NapCat 端口、DSH 端口、副作用队列积压、定时任务最后投递、心跳、孤儿任务。',
      '规则很硬：**同一项连续 3 次失败才算 critical**，单次失败只是 warn；探测不到（文件不存在等）算 unknown，不算失败。',
      '所以看到 warn 不用慌，看到 critical 才说明这东西真的连续坏了三次。',
    ].join(''),
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          critical: { type: 'number', description: '处于 critical 的项数' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                status: { type: 'string', description: 'ok / warn / critical / unknown' },
                failureStreak: { type: 'number' },
                detail: { type: 'string' },
              },
            },
            description: '每一项的探测结果',
          },
          reportPath: { type: 'string', description: 'report.md 的绝对路径' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `自检失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        const lines = (r.items || []).map((i) => `- ${i.name}: ${i.status}（连续失败 ${i.failureStreak ?? 0}）${i.detail ? ` · ${i.detail}` : ''}`)
        // 抬头必须区分 warn 与 critical：只看 critical>0 会把「2 项告警」也印成「全部正常」，
        // 那句话会安抚人 —— 将来真出问题时容易被它糊过去（实测踩过）。
        const countOf = (s) => (r.items || []).filter((i) => i.status === s).length
        const crit = countOf('critical')
        const warn = countOf('warn')
        const unknown = countOf('unknown')
        const head = crit > 0
          ? `⚠️ ${crit} 项 critical（连续 3 次失败）${warn > 0 ? `，另有 ${warn} 项告警` : ''}`
          : warn > 0
            ? `⚠️ 无 critical，但 ${warn} 项告警（连续失败未满 3 次，还没升 critical）`
            : '全部正常'
        const tail = unknown > 0 ? `（另有 ${unknown} 项探不到，不算故障）` : ''
        return `${head}${tail}\n${lines.join('\n')}`
      }),
    },
    handler,
  })
}

// ── work_policy ───────────────────────────────────────────────────────────

/**
 * `work_policy`：读 / 改授权策略（M5）。
 *
 * 不带 `acceptMode` = 读；带了 = 改（version+1、写 history、给**在跑工单**发 `policy-changed` 事件）。
 *
 * `auto` 目前**不实现**：P2 只做到 observe（扫描 + 提醒，绝不改单）。读到 auto 一律降级成
 * observe 并在返回里标 `downgraded:'auto-not-implemented'` —— 绝不假装支持一个没做的模式。
 *
 * 注意职责边界：policy 模块只管存取，**不认识 store**；给工单发事件是这里做的（接线层）。
 */
export function createWorkPolicyTool(deps = {}) {
  const { store } = deps
  const policy = deps.policy
  if (!policy) return null // 没装 policy 就不暴露这个工具（和 health_check 同样的可选性）

  const updatedBy = typeof deps.defaultRole === 'string' && deps.defaultRole ? deps.defaultRole : 'lead'

  /** 给所有「开着」的工单追加一条 policy-changed（已关闭的不打扰） */
  async function notifyOpenTickets(meta) {
    const notified = []
    if (!store) return { notified, error: 'store 未注入，无法通知工单' }
    try {
      const idx = await store.readIndex(Date.now())
      if (idx.ok !== true) return { notified, error: `读索引失败：${idx.code || 'UNKNOWN'}` }
      const rows = Array.isArray(idx.index && idx.index.tickets) ? idx.index.tickets : []
      for (const row of rows) {
        if (!row || !row.id || row.stage === STAGE.CLOSED) continue
        const ev = await store.appendEvent({
          ts: new Date().toISOString(),
          ticketId: row.id,
          type: 'policy-changed',
          by: updatedBy,
          role: updatedBy,
          sessionId: '',
          payload: {
            fromVersion: meta.fromVersion,
            version: meta.version,
            from: meta.from,
            to: meta.to,
          },
        })
        if (ev && ev.ok === true) notified.push(row.id)
      }
      return { notified, error: '' }
    } catch (e) {
      return { notified, error: `通知工单时异常：${e && e.message ? e.message : String(e)}` }
    }
  }

  const handler = async (args) => {
    try {
      if (!policy) return { ok: false, code: 'NOT_CONFIGURED', message: 'work_policy 缺少 policy 依赖' }
      const a = argObj(args)
      const wanted = str(a.acceptMode).trim()
      const wantHistory = a.history === true

      const out = {
        ok: true,
        action: 'read',
        version: 0,
        acceptMode: '',
        effectiveAcceptMode: '',
        updatedAt: '',
        updatedBy: '',
        source: '',
        changed: false,
        fromVersion: 0,
        notified: [],
        notifyError: '',
        downgraded: '',
        history: [],
        historyTotal: 0,
        message: '',
      }

      if (wanted) {
        const upd = policy.update({ acceptMode: wanted }, { updatedBy })
        if (upd.ok !== true) return upd
        out.action = 'update'
        out.changed = upd.changed === true
        out.fromVersion = Number(upd.fromVersion) || 0
        out.version = Number(upd.version) || 0
        out.acceptMode = str(upd.policy && upd.policy.acceptMode)
        out.updatedAt = str(upd.policy && upd.policy.updatedAt)
        out.updatedBy = str(upd.policy && upd.policy.updatedBy)
        out.source = 'file'
        if (out.changed) {
          const n = await notifyOpenTickets({
            fromVersion: out.fromVersion,
            version: out.version,
            from: wanted, // 注意：from 的真实旧值 policy 模块已在 history 里留档
            to: out.acceptMode,
          })
          out.notified = n.notified
          out.notifyError = n.error
        }
      } else {
        const cur = policy.read()
        if (cur.ok !== true) return cur
        out.action = 'read'
        out.version = Number(cur.version) || 0
        out.acceptMode = str(cur.policy && cur.policy.acceptMode)
        out.updatedAt = str(cur.policy && cur.policy.updatedAt)
        out.updatedBy = str(cur.policy && cur.policy.updatedBy)
        out.source = str(cur.source)
      }

      // auto → observe 降级（P2 不实现 auto）
      out.effectiveAcceptMode = out.acceptMode === 'auto' ? 'observe' : out.acceptMode
      if (out.acceptMode === 'auto') out.downgraded = 'auto-not-implemented'

      if (wantHistory) {
        const h = policy.history({ limit: 20 })
        if (h.ok === true) {
          const entries = Array.isArray(h.entries) ? h.entries : []
          out.history = entries.map((e) => ({
            version: Number(e.version) || 0,
            fromVersion: Number(e.fromVersion) || 0,
            acceptMode: str(e.acceptMode),
            updatedAt: str(e.updatedAt),
            updatedBy: str(e.updatedBy),
          }))
          out.historyTotal = Number(h.total) || out.history.length
        }
      }

      out.message = out.action === 'update'
        ? (out.changed
          ? `策略已更新：v${out.fromVersion} → v${out.version}，acceptMode=${out.acceptMode}，通知了 ${out.notified.length} 张在跑工单`
          : `值没变（仍是 ${out.acceptMode}），版本保持 v${out.version}，未写历史`)
        : `当前策略 v${out.version}：acceptMode=${out.acceptMode}（生效值 ${out.effectiveAcceptMode}）`

      return out
    } catch (err) {
      return fail(err)
    }
  }

  return toolOf({
    name: 'work_policy',
    description: [
      '读 / 改授权策略（M5 版本化）。不带参数=读，带 acceptMode=改。',
      '三档：off=看门狗不扫描；observe=扫描+提醒但绝不改单（默认）；auto=自动执行，**P2 未实现**，读到会降级为 observe 并标记 downgraded。',
      '改动会让 version+1 并写进 policy-history.jsonl 留档，同时给所有未关闭的工单追加一条 policy-changed 事件。',
      '值没变不算改动：不升版本、不写历史。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        acceptMode: { type: 'string', enum: ['off', 'observe', 'auto'], description: '改成这一档；不填=只读' },
        history: { type: 'boolean', description: '顺带返回最近 20 条变更历史' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          action: { type: 'string', description: 'read | update' },
          version: { type: 'number', description: '当前策略版本号' },
          acceptMode: { type: 'string', description: '文件里存的档位' },
          effectiveAcceptMode: { type: 'string', description: '实际生效的档位（auto 会降级成 observe）' },
          updatedAt: { type: 'string', description: '最后变更时间；从未变更为空串' },
          updatedBy: { type: 'string', description: '最后改动人；从未变更为空串' },
          source: { type: 'string', description: 'file | default' },
          changed: { type: 'boolean', description: '这次是否真的改了' },
          fromVersion: { type: 'number', description: '改动前的版本' },
          notified: { type: 'array', items: { type: 'string' }, description: '收到 policy-changed 的工单 id' },
          notifyError: { type: 'string', description: '通知工单失败时的原因；正常为空串' },
          downgraded: { type: 'string', description: '被降级的模式名；没降级为空串' },
          history: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                version: { type: 'number' },
                fromVersion: { type: 'number' },
                acceptMode: { type: 'string' },
                updatedAt: { type: 'string' },
                updatedBy: { type: 'string' },
              },
            },
            description: '请求了 history 时才有内容',
          },
          historyTotal: { type: 'number', description: '历史总条数' },
          message: { type: 'string', description: '一句人话总结' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `策略操作失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        const lines = [`${r.message}`]
        if (r.downgraded) lines.push(`⚠ auto 尚未实现，本次按 observe 执行（不会自动改单、不会自动派单）`)
        if (r.notified && r.notified.length > 0) lines.push(`已通知工单：${r.notified.join(', ')}`)
        if (r.notifyError) lines.push(`⚠ 通知工单时出问题：${r.notifyError}`)
        if (r.history && r.history.length > 0) {
          lines.push(`最近变更（共 ${r.historyTotal} 条）：`)
          for (const h of r.history.slice(0, 8)) {
            lines.push(`- v${h.fromVersion}→v${h.version} ${h.acceptMode} · ${h.updatedAt} · ${h.updatedBy || '-'}`)
          }
        }
        return lines.join('\n')
      }),
    },
    handler,
  })
}

// ── work_watchdog ─────────────────────────────────────────────────────────

/**
 * `work_watchdog`：跑一次**只读**扫描，列出停滞 / 卡死 / 等待过久的工单。
 *
 * 只读是硬约束，但**不靠自觉**：判断依据是 watchdog 模块自己算的 `unchanged`
 * （扫描前后逐文件 sha256 比对）。真出现差异会如实给 false，不粉饰。
 *
 * `acceptMode` 在这里生效：`off` 干脆不扫；`observe` 正常扫；`auto` P2 没实现，
 * 按 observe 跑并标 `downgraded` —— 绝不假装在自动干活。
 */
export function createWorkWatchdogTool(deps = {}) {
  const watchdog = deps.watchdog
  const policy = deps.policy
  if (!watchdog) return null // 没装 watchdog 就不暴露

  const num = (v, fb) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fb
  }

  /** item 归一：所有字符串字段空值给 ''，数字给 0，绝不给 null */
  const normItem = (x) => {
    const o = x && typeof x === 'object' ? x : {}
    return {
      id: str(o.id),
      title: str(o.title),
      stage: str(o.stage),
      stageLabel: str(o.stageLabel),
      priority: str(o.priority),
      ownerRole: str(o.ownerRole),
      ownerSessionId: str(o.ownerSessionId),
      updatedAt: str(o.updatedAt),
      idleForMs: Number(o.idleForMs) > 0 ? Number(o.idleForMs) : 0,
      lastOutcome: str(o.lastOutcome),
    }
  }

  /** 复现模式一条的归一：字段集合固定六个，空值给 '' / 0 / []，绝不给 null */
  const normPattern = (x) => {
    const o = x && typeof x === 'object' ? x : {}
    return {
      problemClass: str(o.problemClass),
      occurrences: Number(o.occurrences) > 0 ? Math.floor(Number(o.occurrences)) : 0,
      reports: Number(o.reports) > 0 ? Math.floor(Number(o.reports)) : 0,
      ticketIds: Array.isArray(o.ticketIds) ? o.ticketIds.map((id) => str(id)).filter(Boolean) : [],
      fixWorthy: o.fixWorthy === true,
      needsAttention: o.needsAttention === true,
    }
  }

  const fmtAge = (ms) => {
    const n = Number(ms) || 0
    if (n <= 0) return '未知'
    const m = Math.floor(n / 60000)
    if (m < 60) return `${m} 分钟`
    const h = Math.floor(m / 60)
    if (h < 48) return `${h} 小时`
    return `${Math.floor(h / 24)} 天`
  }

  const handler = async (args) => {
    try {
      const a = argObj(args)
      const idleMsArg = num(a.idleMs, 0)
      const waitingMsArg = num(a.waitingMs, 0)

      // 先看策略
      let acceptMode = 'observe'
      let downgraded = ''
      let policyVersion = 0
      if (policy) {
        const cur = policy.read()
        if (cur.ok === true) {
          acceptMode = str(cur.policy && cur.policy.acceptMode) || 'observe'
          policyVersion = Number(cur.version) || 0
        }
      }
      if (acceptMode === 'auto') {
        downgraded = 'auto-not-implemented'
        acceptMode = 'observe'
      }
      if (!['off', 'observe'].includes(acceptMode)) acceptMode = 'observe'

      const out = {
        ok: true,
        ts: '',
        stalled: [],
        stuck: [],
        waiting: [],
        counts: { stalled: 0, stuck: 0, waiting: 0 },
        patterns: [],
        patternsError: '',
        unchanged: true,
        acceptMode,
        effectiveAcceptMode: acceptMode,
        policyVersion,
        downgraded,
        skipped: false,
        message: '',
      }

      if (acceptMode === 'off') {
        out.skipped = true
        out.message = 'acceptMode=off：看门狗不扫描'
        return out
      }

      const scanOpts = {}
      if (idleMsArg > 0) scanOpts.idleMs = idleMsArg
      if (waitingMsArg > 0) scanOpts.waitingMs = waitingMsArg

      const r = await watchdog.scan(scanOpts)
      if (r.ok !== true) return r

      out.ts = str(r.ts)
      out.stalled = (Array.isArray(r.stalled) ? r.stalled : []).map(normItem)
      out.stuck = (Array.isArray(r.stuck) ? r.stuck : []).map(normItem)
      out.waiting = (Array.isArray(r.waiting) ? r.waiting : []).map(normItem)
      out.counts = {
        stalled: out.stalled.length,
        stuck: out.stuck.length,
        waiting: out.waiting.length,
      }
      out.unchanged = r.unchanged === true

      // ── 复现模式（账本整合 A2）─────────────────────────────────────────
      // 从事件流**现算**：不落盘新状态、不加寿命、不引依赖。只报出现 ≥2 次的类
      // （出现 1 次只记录，不许进报告——否则「进该修名单」这条分级就没了意义）。
      const pat = typeof watchdog.patterns === 'function' ? await watchdog.patterns() : null
      if (pat && pat.ok === true && Array.isArray(pat.patterns)) {
        out.patterns = pat.patterns
          .filter((row) => row && Number(row.occurrences) >= FIX_MIN_OCCURRENCES)
          .map(normPattern)
      } else if (pat && pat.ok === false) {
        out.patternsError = str(pat.message) || '复现模式没算出来'
      }

      const total = out.counts.stalled + out.counts.stuck + out.counts.waiting
      const patTail = out.patterns.length > 0 ? `；另发现 ${out.patterns.length} 类复现模式` : ''
      out.message = total === 0
        ? `没有需要关注的工单${patTail}`
        : `有 ${total} 张需要关注：停滞 ${out.counts.stalled} · 卡死 ${out.counts.stuck} · 等待过久 ${out.counts.waiting}${patTail}`

      return out
    } catch (err) {
      return fail(err)
    }
  }

  const itemSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      stage: { type: 'string' },
      stageLabel: { type: 'string' },
      priority: { type: 'string' },
      ownerRole: { type: 'string' },
      ownerSessionId: { type: 'string' },
      updatedAt: { type: 'string' },
      idleForMs: { type: 'number', description: '距上次更新多少毫秒（算不出来就是 0）' },
      lastOutcome: { type: 'string' },
    },
    required: ['id'],
  }

  const patternSchema = {
    type: 'object',
    properties: {
      problemClass: { type: 'string', description: '错误分类（kebab-case）' },
      occurrences: { type: 'number', description: '出现在多少张不同的工单上（≥2 才进这一节）' },
      reports: { type: 'number', description: '一共报了多少次（同一张单重复报的也算在这里）' },
      ticketIds: { type: 'array', items: { type: 'string' }, description: '涉及哪些工单' },
      fixWorthy: { type: 'boolean', description: 'true = 进「该修」名单（≥2 次）' },
      needsAttention: { type: 'boolean', description: 'true = 需要重视（≥3 次）' },
    },
    required: ['problemClass', 'occurrences'],
  }

  return toolOf({
    name: 'work_watchdog',
    description: [
      '跑一次**只读**扫描，列出三类需要人看一眼的工单：',
      '停滞（开着但 2 小时没动）/ 卡死（连续 3 次失败）/ 等待过久（等回话或审阅超过 24 小时）。',
      '另附一节「🔁 复现模式」：同一个 problemClass 出现在 ≥2 张工单上（≥3 张标需要重视），',
      '从事件流现算、不落盘、不加寿命——它只负责让你看见「同一类坑又踩了」。',
      '这个工具绝不改任何工单——它连索引都不会重建写盘，扫完还会用 sha256 自证文件没被碰过。',
      'acceptMode=off 时直接不扫；=auto 时 P2 未实现，按 observe 跑并标记 downgraded。',
      '定时任务（每 30 分钟）就靠它发现问题，然后用 pending 记一条提醒人，而不是去改单。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        idleMs: { type: 'number', description: '停滞阈值（毫秒），默认 2 小时；一般不用填' },
        waitingMs: { type: 'number', description: '等待阈值（毫秒），默认 24 小时；一般不用填' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...FAIL_PROPS,
          ts: { type: 'string', description: '扫描时刻；拿不到时钟就是空串' },
          stalled: { type: 'array', items: itemSchema, description: '停滞：开着但很久没动' },
          stuck: { type: 'array', items: itemSchema, description: '卡死：连续 3 次失败' },
          waiting: { type: 'array', items: itemSchema, description: '等待过久' },
          patterns: {
            type: 'array',
            items: patternSchema,
            description: '复现模式：同一 problemClass 出现在 ≥2 张工单上（从事件流现算，不落盘）',
          },
          patternsError: { type: 'string', description: '复现模式没算出来时的原因；正常为空串' },
          counts: {
            type: 'object',
            properties: {
              stalled: { type: 'number' },
              stuck: { type: 'number' },
              waiting: { type: 'number' },
            },
            description: '三类各自的条数',
          },
          unchanged: { type: 'boolean', description: '扫描前后工单文件是否逐字节未变（只读自证）' },
          acceptMode: { type: 'string', description: '策略里的档位' },
          effectiveAcceptMode: { type: 'string', description: '实际生效的档位' },
          policyVersion: { type: 'number', description: '当前策略版本号' },
          downgraded: { type: 'string', description: '被降级的模式；没降级为空串' },
          skipped: { type: 'boolean', description: '是否因 acceptMode=off 而未扫描' },
          message: { type: 'string', description: '一句人话总结' },
        },
        required: ['ok'],
      },
      render: renderer((r) => {
        if (!r || r.ok !== true) return `看门狗扫描失败：${r?.code ?? 'UNKNOWN'}${r?.message ? ` — ${r.message}` : ''}`
        if (r.skipped) return `${r.message}（acceptMode=off，跳过扫描）`
        const lines = [`${r.message}`]
        const sec = (name, arr) => {
          if (!arr || arr.length === 0) return
          lines.push(`【${name}】${arr.length} 张`)
          for (const it of arr) {
            const owner = it.ownerRole || it.ownerSessionId || '未认领'
            lines.push(`  · ${it.id} [${it.stageLabel || it.stage}] ${it.title || '(无标题)'}`
              + `（${it.priority || '-'} · ${owner} · 停了 ${fmtAge(it.idleForMs)}）`)
          }
        }
        sec('停滞', r.stalled)
        sec('卡死', r.stuck)
        sec('等待过久', r.waiting)
        if (Array.isArray(r.patterns) && r.patterns.length > 0) {
          lines.push(`【🔁 复现模式】${r.patterns.length} 类`)
          for (const p of r.patterns) {
            const verdict = p.needsAttention === true ? '需要重视（≥3 次）' : '该修（≥2 次）'
            lines.push(`  · \`${p.problemClass}\` ${p.occurrences} 张单 / ${p.reports} 次报告 → ${verdict}`
              + `${Array.isArray(p.ticketIds) && p.ticketIds.length > 0 ? `（${p.ticketIds.join(', ')}）` : ''}`)
          }
          lines.push('  （同一类问题在不同工单上反复出现才值得修；看门狗只报，不动单）')
        }
        if (r.patternsError) lines.push(`⚠ 复现模式没算出来：${r.patternsError}`)
        if (r.downgraded) lines.push(`⚠ auto 尚未实现，本次按 observe 执行（只看不动）`)
        lines.push(r.unchanged ? `只读自证：工单文件逐字节未变 ✓` : `⚠ 扫描期间工单文件有变化（可能是别的进程在改）`)
        return lines.join('\n')
      }),
    },
    handler,
  })
}

/** 六个基础工厂的清单（接线层 for 一遍就能注册，不用记顺序）。 */
export const WORK_TOOL_FACTORIES = Object.freeze([
  createWorkOpenTool,
  createWorkReportTool,
  createWorkListTool,
  createWorkGetTool,
  createWorkCloseTool,
  createWorkAttachTool,
  // 账本整合 A3.2：单向指认（工单 → 错题本）。无条件注册——它不依赖任何可选模块，
  // 一个纯 store 追加操作，没有失败面。
  createWorkLinkLessonTool,
])

/**
 * 一把建出全部工具（方便 index.js 一行接线）。
 * `health` 注入了就多一个 `health_check`；没注入就只返回六个。
 *
 * @param {{store: object, health?: object, defaultRole?: string, log?: object}} deps
 * @returns {Array<object>}
 */
export function createWorkQueueTools(deps = {}) {
  if (!deps || !deps.store) return []
  const tools = WORK_TOOL_FACTORIES.map((factory) => factory(deps))
  // 可选工具：依赖注入了才有，没注入就静悄悄不暴露（绝不注册一个坏工具）
  const policyTool = createWorkPolicyTool(deps)
  if (policyTool) tools.push(policyTool)
  const watchdogTool = createWorkWatchdogTool(deps)
  if (watchdogTool) tools.push(watchdogTool)
  const healthTool = createHealthCheckTool(deps)
  if (healthTool) tools.push(healthTool)
  return tools
}
