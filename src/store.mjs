/**
 * src/store.mjs —— 工单落盘层（tickets/*.json + events.jsonl + index.json + work/<short>/）。
 *
 * ⚠️ 这里写出来的文件**不是给模型读的**。它们是运行时状态，会被 append-only 地反复追加；
 * 任何"把工单文件当事实背下来"的行为都是错的。模型只看工具返回值。
 *
 * 四条设计约束，改代码前先读：
 *
 * 1. **原子写**：任何 ticket / index 都先写 `<file>.tmp` 再 `fs.renameSync`。直接覆盖写会在
 *    进程被杀的瞬间留下半截 JSON，而半截 JSON 会让 work_list 整体读失败——一张坏单拖垮整个
 *    看板，这是不可接受的耦合。（rename 在同一卷上是原子的：读者要么看到旧文件、要么看到
 *    新文件，永远看不到"写了一半"。跨进程撞同一个 .tmp 名是已知限制，见 §1.6 的部署假设：
 *    只允许一个 DSH 写这份数据。）
 *
 * 2. **单写入者**：同一张单的写操作在进程内用 `Map<id, Promise>` 串成链（不是 sleep 轮询）。
 *    跨进程靠"只允许一个 DSH"这个部署事实（和 effect-queue、receipts 一样的假设），
 *    不引文件锁——引了就要处理锁残留，比它解决的问题更难缠。
 *
 * 3. **事件是权威，ticket 正文是投影**：`events.jsonl` 只追加不修改；ticket 上的
 *    `lastReport` / `failStreak` / `reports` 只是为了让 `work_list` 不必每次扫全量事件而维护的
 *    缓存。两者不一致时**以事件为准**（stage.mjs 就是按这个假设写的）。
 *
 * 4. **永不 throw**：本模块所有对外方法都返回 `{ ok:true, ... }` 或
 *    `{ ok:false, code, message }`。内部仍然用 `StoreError` 表达失败（好写、好读），
 *    但出口统一由 `guard()` 转成返回值——工具抛异常会把整轮对话炸掉，这是不可接受的故障模式。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { deriveStage, lastOutcome } from './stage.mjs'

export const SCHEMA_VERSION = 1
export const TICKETS_DIR = 'tickets'
export const WORK_DIR = 'work'
export const EVENTS_FILE = 'events.jsonl'
export const INDEX_FILE = 'index.json'

/** 只读事件文件末尾这么多字节（和 effect-queue 同一取舍：全量扫会随运行时间线性变慢）。 */
export const READ_TAIL_BYTES = 4 * 1024 * 1024

/**
 * events.jsonl 的第一行是给人看的说明，不是事件。
 * 判据：带 `_` 字段的行一律跳过（`_` 不作为任何真实事件的字段名）。
 */
export const EVENTS_HEADER = JSON.stringify({
  _: '这不是给模型读的状态文件：工单事件流，append-only，只由 work-queue 插件写入',
})

/** 内部错误（不对外抛：出口统一走 guard()）。 */
class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

function iso(ms) {
  return new Date(ms).toISOString()
}

/** 把任意异常压成 `{ ok:false, code, message }`。 */
function failOf(error, fallbackCode = 'IO_ERROR') {
  const code = error && typeof error.code === 'string' && error.code.length > 0 && /^[A-Z_]+$/.test(error.code)
    ? error.code
    : fallbackCode
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : String(error)
  return { ok: false, code, message }
}

/**
 * 生成工单 id：`t-` + **8 位 base36**（spec §3.1）。
 *
 * 前 5 位来自秒级时间戳（保证**大致按创建顺序可排序**，排查时肉眼能看出先后），
 * 后 3 位随机（36^3 = 46656，同一秒内连开多单不撞）。撞了就换一个——openTicket 里有重试。
 */
export function newTicketId(nowMs = Date.now()) {
  const stamp = Math.floor(Number(nowMs) / 1000).toString(36).slice(-5).padStart(5, '0')
  const rand = crypto.randomInt(0, 36 ** 3).toString(36).padStart(3, '0')
  return `t-${stamp}${rand}`
}

/** `t-abc12345` → `abc12345`（一单一目录用这个当目录名）。 */
export function shortOf(id) {
  return String(id || '').replace(/^t-/, '')
}

/**
 * 一次 rename 完成的原子写。
 *
 * tmp 名固定为 `<file>.tmp`（spec §1.3 的字面要求）。不用 pid/随机后缀的理由：
 * 同进程内同 id 的写已经被串行链挡住，跨进程场景本就假设"只有一个 DSH 在写"；
 * 加后缀反而会让崩溃后的残留 tmp 越来越多、且无法被"下次写"顺手覆盖掉。
 */
function atomicWriteFile(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    // rename 失败时尽力清掉 tmp，但**不要**因为清理失败而改写原始错误
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 忽略：tmp 残留不影响正确性（下次写会覆盖它） */
    }
    throw error
  }
}

/** 把同步函数包成"永不 throw"的异步方法。 */
function guard(fn) {
  return async (...args) => {
    try {
      const value = await fn(...args)
      if (value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, ...value }
      return { ok: true, value }
    } catch (error) {
      return failOf(error)
    }
  }
}

/** dataDir 没给时返回一个"每一步都如实报错"的空壳，而不是 throw。 */
function brokenStore(code, message) {
  const fail = async () => ({ ok: false, code, message })
  return {
    ok: false,
    code,
    message,
    dataDir: null,
    ticketsDir: null,
    eventsPath: null,
    indexPath: null,
    ticketPath: () => null,
    workDirOf: () => null,
    ensureDirs: fail,
    newId: fail,
    openTicket: fail,
    reportTicket: fail,
    attachTicket: fail,
    closeTicket: fail,
    getTicket: fail,
    readTicket: fail,
    readEvents: fail,
    listTickets: fail,
    readIndex: fail,
    rebuildIndex: fail,
    appendEvent: fail,
    runExclusive: fail,
  }
}

/**
 * 创建存储层。数据根目录由调用方传入（本模块**不写死** `~/.dsh-beta`）。
 *
 * @param {object}   opts
 * @param {string}   opts.dataDir  数据根目录（如 `~/.dsh-beta/workqueue`）
 * @param {Function} [opts.nowMs]  取当前时间的函数（测试可注入固定时钟）
 */
export function createStore({ dataDir, nowMs } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    return brokenStore('NO_DATA_DIR', 'createStore 需要 dataDir（数据根目录由调用方传入，本模块不猜）')
  }

  const root = path.resolve(dataDir)
  const ticketsDir = path.join(root, TICKETS_DIR)
  const workRoot = path.join(root, WORK_DIR)
  const eventsPath = path.join(root, EVENTS_FILE)
  const indexPath = path.join(root, INDEX_FILE)
  const clock = typeof nowMs === 'function' ? nowMs : () => Date.now()

  /** 同 id 写操作串行链。key 是 ticket id，value 是链尾 Promise（永远不 reject）。 */
  const chains = new Map()

  function ensureDirs() {
    fs.mkdirSync(ticketsDir, { recursive: true })
    fs.mkdirSync(workRoot, { recursive: true })
  }

  function ticketPath(id) {
    return path.join(ticketsDir, `${id}.json`)
  }

  /**
   * 索引只是缓存：**任何一次写之后都让它失效**，下次 `readIndex` 必整份重建。
   *
   * 为什么不是"写的时候顺手更新索引里那一行"：增量维护要同时保证 count、stage、lastOutcome、
   * corrupt 四处一致，写错一处就静默给出错状态；而重建只是一次目录扫描 + 一次事件文件读，
   * 在单机几十张单的量级上根本不值得省。
   *
   * 代价（写进注释以免以后被人当成 bug）：`count` 相同但内容变了时（同一张单又报了一次）
   * 索引必须靠这次 unlink 才知道要重建——所以这行不能省。
   */
  function invalidateIndex() {
    try {
      fs.unlinkSync(indexPath)
    } catch {
      /* 不存在就算了 */
    }
  }

  /** 一单一目录：该单的中间产物都落这里，别污染别处。 */
  function workDirOf(id) {
    return path.join(workRoot, shortOf(id))
  }

  /**
   * 把 fn 排到 id 的串行链尾部。
   * 返回 `{ ok:true, value }` / `{ ok:false, code, message }`——不 throw。
   */
  async function runExclusive(id, fn) {
    const prev = chains.get(id) || Promise.resolve()
    const run = prev.then(() => fn())
    const tail = run.then(() => {}, () => {})
    chains.set(id, tail)
    tail.then(() => {
      // 链尾跑完且没被后来者替换 → 回收，避免 Map 无界增长
      if (chains.get(id) === tail) chains.delete(id)
    })
    try {
      return { ok: true, value: await run }
    } catch (error) {
      return failOf(error)
    }
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────

  function appendEventUnsafe(event) {
    ensureDirs()
    if (!fs.existsSync(eventsPath)) {
      // 用 append（而不是 write）写首行说明：即便两个调用同时进来，也不会把对方刚追加的事件截掉。
      // 最坏情况是说明行重复一次，读的时候按 `_` 字段跳过即可。
      fs.appendFileSync(eventsPath, `${EVENTS_HEADER}\n`, 'utf8')
    }
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, 'utf8')
    invalidateIndex()
    return { event }
  }

  /**
   * 读事件流。默认只读末尾 `READ_TAIL_BYTES`，跳过说明行与任何坏行。
   *
   * 注意：读末尾意味着**极老的工单事件可能读不到**。这是刻意的——事件流的用途是"最近发生了什么"，
   * 历史归 ticket 正文和 stage 派生（lastOutcome 有投影字段兜底），不靠这里。
   */
  function readEventsUnsafe(ticketId = null, limit = 0, tailBytes = READ_TAIL_BYTES) {
    if (!fs.existsSync(eventsPath)) return { events: [] }
    let raw
    try {
      const size = fs.statSync(eventsPath).size
      const start = Math.max(0, size - tailBytes)
      if (start === 0) {
        raw = fs.readFileSync(eventsPath, 'utf8')
      } else {
        const fd = fs.openSync(eventsPath, 'r')
        try {
          const buf = Buffer.alloc(size - start)
          fs.readSync(fd, buf, 0, buf.length, start)
          raw = buf.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
        // 从中间开始读，第一行必然是残行，丢掉
        const nl = raw.indexOf('\n')
        raw = nl >= 0 ? raw.slice(nl + 1) : ''
      }
    } catch {
      return { events: [] }
    }

    const out = []
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      let ev
      try {
        ev = JSON.parse(text)
      } catch {
        continue // 坏行跳过：一行坏了不该让整次读取失败
      }
      if (!ev || typeof ev !== 'object' || ev._) continue // 说明行
      if (ticketId && ev.ticketId !== ticketId) continue
      out.push(ev)
    }
    if (limit > 0 && out.length > limit) return { events: out.slice(-limit) }
    return { events: out }
  }

  /** 全量事件按 ticketId 分组（重建索引时用一次，避免每个单都扫一遍文件）。 */
  function groupEvents() {
    const byId = new Map()
    for (const ev of readEventsUnsafe(null, 0).events) {
      if (!byId.has(ev.ticketId)) byId.set(ev.ticketId, [])
      byId.get(ev.ticketId).push(ev)
    }
    return byId
  }

  // ── ticket 读写 ───────────────────────────────────────────────────────────

  function writeTicketUnsafe(ticket) {
    ensureDirs()
    atomicWriteFile(ticketPath(ticket.id), `${JSON.stringify(ticket, null, 2)}\n`)
    invalidateIndex()
    return { ticket }
  }

  /** 读一张单；不存在 → null；坏 JSON → 抛 CORRUPT_TICKET（由 list 决定怎么跳过）。 */
  function readTicketRaw(id) {
    if (!id || typeof id !== 'string') throw new StoreError('BAD_INPUT', '工单 id 必填')
    const file = ticketPath(id)
    if (!fs.existsSync(file)) return null
    const text = fs.readFileSync(file, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new StoreError('CORRUPT_TICKET', `工单文件不是合法 JSON：${file}`)
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
      throw new StoreError('CORRUPT_TICKET', `工单文件缺少 id：${file}`)
    }
    return parsed
  }

  /**
   * 列出所有 ticket。坏文件**跳过并记进 `corrupt`**，不让一张坏单拖垮整个看板。
   * `fileCount` 是磁盘上的文件数（含损坏的），索引用它判断"有没有人动过目录"。
   */
  function listTicketsUnsafe() {
    ensureDirs()
    const ids = []
    for (const name of fs.readdirSync(ticketsDir)) {
      if (!name.endsWith('.json')) continue
      if (name.includes('.tmp')) continue // 半截写入的残留，绝不当成工单
      ids.push(name.slice(0, -'.json'.length))
    }
    const tickets = []
    const corrupt = []
    for (const id of ids) {
      try {
        const t = readTicketRaw(id)
        if (t) tickets.push(t)
      } catch {
        corrupt.push(id)
      }
    }
    return { tickets, corrupt, fileCount: ids.length }
  }

  // ── 索引（只是缓存，坏了不影响正确性）────────────────────────────────────

  function rebuildIndexUnsafe(nowArg) {
    const listed = listTicketsUnsafe()
    const byId = groupEvents()
    const now = Number.isFinite(Number(nowArg)) ? Number(nowArg) : clock()

    const rows = listed.tickets.map((t) => {
      const events = byId.get(t.id) || []
      return {
        id: t.id,
        title: t.title,
        stage: deriveStage(t, events, now),
        priority: t.priority,
        owner: t.owner || null,
        updatedAt: t.updatedAt,
        lastOutcome: lastOutcome(t, events),
        closedAt: t.closedAt || null,
      }
    })

    const body = {
      schemaVersion: SCHEMA_VERSION,
      builtAt: iso(now),
      count: rows.length,
      fileCount: listed.fileCount,
      corrupt: listed.corrupt,
      tickets: rows,
    }

    let persisted = true
    try {
      ensureDirs()
      atomicWriteFile(indexPath, `${JSON.stringify(body, null, 2)}\n`)
    } catch {
      persisted = false // 索引写不进去也不影响正确性：这次用内存里的那份
    }
    return { index: body, rebuilt: true, persisted }
  }

  /**
   * 读索引；**不存在 / 解析失败 / count 与实际文件数不符 → 自动整份重建**。
   * 索引只是为了省掉"每张单都扫一遍事件"的成本，坏了不影响正确性。
   */
  function readIndexUnsafe(nowArg) {
    const listed = listTicketsUnsafe()
    let cached = null
    try {
      if (fs.existsSync(indexPath)) cached = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    } catch {
      cached = null
    }
    const fresh = cached
      && cached.schemaVersion === SCHEMA_VERSION
      && Array.isArray(cached.tickets)
      && cached.count === listed.tickets.length
      && cached.fileCount === listed.fileCount

    if (fresh) {
      // corrupt 列表每次现算：索引里那份只反映"重建那一刻"，而现在坏掉的文件必须当场说出
      return { index: { ...cached, corrupt: listed.corrupt }, rebuilt: false, persisted: true }
    }
    return rebuildIndexUnsafe(nowArg)
  }

  // ── 对外操作（内部抛 StoreError，出口由 guard 兜住）──────────────────────

  async function openTicketUnsafe({ title, desc = '', kind = 'manual', priority = 'p1', owner = null, cwd = null } = {}) {
    const cleanTitle = String(title == null ? '' : title).trim()
    if (!cleanTitle) throw new StoreError('BAD_INPUT', 'title 不能为空')
    if (cleanTitle.length > 200) throw new StoreError('BAD_INPUT', 'title 超过 200 字')

    const now = clock()
    let id = newTicketId(now)
    // 极小概率撞 id：撞了就换一个，最多试 5 次
    for (let i = 0; i < 5 && fs.existsSync(ticketPath(id)); i += 1) id = newTicketId(clock())

    const ticket = {
      id,
      schemaVersion: SCHEMA_VERSION,
      title: cleanTitle,
      desc: String(desc == null ? '' : desc),
      kind: String(kind || 'manual'),
      priority: ['p0', 'p1', 'p2'].includes(priority) ? priority : 'p1',
      owner: owner && typeof owner === 'object'
        ? { role: owner.role || null, sessionId: owner.sessionId || null }
        : { role: null, sessionId: null },
      cwd: cwd || null,
      createdAt: iso(now),
      updatedAt: iso(now),
      // 这三个字段一律写 ''，不写 null：
      // DSH 工具的 output schema 是 additionalProperties:false 且类型严格，
      // 一个 null 撞上 type:'string' 会让「整个工具结果」被校验层拒收
      // （P1 实测：一张 closedAt 为 null 的空单让 work_list 全部报 invalid output）。
      // 读端兜底只能治标——每新增一个工具都要记得再兜一次，所以从写入端根治。
      // 安全性：stage.mjs L153 用 `if (ticket.closedAt)` 判断关闭，'' 与 null 同为 falsy。
      closedAt: '',
      closedReason: '',
      lastReport: '',
      reports: 0,
      failStreak: 0,
    }

    return runExclusiveWith(id, () => {
      fs.mkdirSync(workDirOf(id), { recursive: true })
      writeTicketUnsafe(ticket)
      appendEventUnsafe({
        ts: ticket.createdAt,
        ticketId: id,
        type: 'open',
        by: ticket.owner.role,
        role: ticket.owner.role,
        sessionId: ticket.owner.sessionId,
        payload: { title: ticket.title, kind: ticket.kind, priority: ticket.priority, cwd: ticket.cwd },
      })
      return { ticket, dir: workDirOf(id) }
    })
  }

  /** runExclusive 的"抛错版"：给内部调用方用，错误继续往上冒到 guard。 */
  async function runExclusiveWith(id, fn) {
    const result = await runExclusive(id, fn)
    if (result.ok !== true) throw new StoreError(result.code, result.message)
    return result.value
  }

  /**
   * 记一次报告。**ready 无 evidence 在这里被降级成 blocked**（spec §1.5 硬闸，不许放宽）。
   *
   * `problemClass`（账本整合 A1）：可选、kebab-case 的错误分类，**只在 requested outcome 为
   * failed / blocked 时落盘**（ready 被降级成 blocked 的那种不算——那不是失败，是没证据）。
   * 它只写进事件 payload 与 ticket.lastReport 投影，**不在 ticket 上维护任何计数器**：
   * 「出现几次」永远由事件流现算（分级响应不加寿命、不加状态，见 spec §2）。
   */
  async function reportTicketUnsafe(id, { outcome, evidence = '', note = '', by = null, problemClass = '' } = {}) {
    const allowed = ['progress', 'ready', 'blocked', 'failed', 'waiting-answer', 'waiting-review']
    if (!allowed.includes(outcome)) {
      throw new StoreError('BAD_INPUT', `outcome 必须是 ${allowed.join('/')} 之一，收到 ${String(outcome)}`)
    }

    return runExclusiveWith(id, () => {
      const ticket = readTicketRaw(id)
      if (!ticket) throw new StoreError('NOT_FOUND', `没有这张工单：${id}`)
      if (ticket.closedAt) throw new StoreError('ALREADY_CLOSED', `工单已关闭：${id}`)

      const cleanEvidence = String(evidence == null ? '' : evidence).trim()
      let effective = outcome
      let downgraded = false
      let extraNote = String(note == null ? '' : note)

      if (outcome === 'ready' && !cleanEvidence) {
        effective = 'blocked'
        downgraded = true
        extraNote = extraNote
          ? `${extraNote} [downgraded: ready-without-evidence]`
          : '[downgraded: ready-without-evidence]'
      }

      // problemClass 只对「本来就是失败/卡住的这次报告」有意义；其它 outcome 一律存空串
      // （不报错、不落噪声：spec §1「其它 outcome 传了会被忽略」）。
      const classAllowed = outcome === 'failed' || outcome === 'blocked'
      const cleanClass = classAllowed ? String(problemClass == null ? '' : problemClass).trim() : ''

      const ts = iso(clock())
      ticket.lastReport = {
        outcome: effective,
        evidence: cleanEvidence,
        note: extraNote,
        at: ts,
        problemClass: cleanClass,
      }
      ticket.reports = (Number(ticket.reports) || 0) + 1
      ticket.failStreak = effective === 'failed' ? (Number(ticket.failStreak) || 0) + 1 : 0
      ticket.updatedAt = ts
      writeTicketUnsafe(ticket)

      // `by` 写**角色名**（谁报的），sessionId 走自己的字段：审计时"lead 报的"比一串 uuid 有用得多
      const actor = by || (ticket.owner && ticket.owner.role) || null
      appendEventUnsafe({
        ts,
        ticketId: id,
        type: 'report',
        by: actor,
        role: actor,
        sessionId: ticket.owner ? ticket.owner.sessionId : null,
        payload: {
          outcome: effective,
          evidence: cleanEvidence,
          note: extraNote,
          requestedOutcome: outcome,
          downgraded,
          // 账本整合 A1：跨工单的「复现模式」全靠这个字段现算，缺了就等于没记
          problemClass: cleanClass,
        },
      })

      return { ticket, downgraded, problemClass: cleanClass }
    })
  }

  /**
   * 换绑会话 / 目录 / 角色（spec §5.6：**只改 owner 与 cwd，不动 stage**）。
   *
   * 刻意**不更新 `updatedAt`**：它是"这张单上一次有实质变化"的时间锚，idle 判定就靠它。
   * 换绑不是进展，若在这里刷新时间戳，一次 attach 就能把 idle 的单悄悄变回 queued/working——
   * 那等于用 attach 改了 stage，与 §5.6 冲突。
   */
  async function attachTicketUnsafe(id, { sessionId, cwd, role } = {}) {
    return runExclusiveWith(id, () => {
      const ticket = readTicketRaw(id)
      if (!ticket) throw new StoreError('NOT_FOUND', `没有这张工单：${id}`)

      const before = { ...(ticket.owner || {}), cwd: ticket.cwd }

      if (sessionId !== undefined) ticket.owner = { ...(ticket.owner || {}), sessionId: sessionId || null }
      if (role !== undefined) ticket.owner = { ...(ticket.owner || {}), role: role || null }
      if (cwd !== undefined) ticket.cwd = cwd || null
      writeTicketUnsafe(ticket)

      appendEventUnsafe({
        ts: iso(clock()),
        ticketId: id,
        type: 'attach',
        by: ticket.owner ? ticket.owner.role : null,
        role: ticket.owner ? ticket.owner.role : null,
        sessionId: ticket.owner ? ticket.owner.sessionId : null,
        payload: { before, after: { role: ticket.owner.role, sessionId: ticket.owner.sessionId, cwd: ticket.cwd } },
      })

      return { ticket }
    })
  }

  /** 关单。**不删文件**——历史留着，事后能查（spec §5.5）。 */
  async function closeTicketUnsafe(id, { conclusion = '', by = null } = {}) {
    const clean = String(conclusion == null ? '' : conclusion).trim()
    if (!clean) throw new StoreError('BAD_INPUT', 'conclusion 不能为空（关单要留下为什么关）')
    if (clean.length > 500) throw new StoreError('BAD_INPUT', 'conclusion 超过 500 字')

    return runExclusiveWith(id, () => {
      const ticket = readTicketRaw(id)
      if (!ticket) throw new StoreError('NOT_FOUND', `没有这张工单：${id}`)
      // 幂等：已关的单再关一次不该报错，也不该再写一条 close 事件
      if (ticket.closedAt) return { ticket, alreadyClosed: true }

      const ts = iso(clock())
      ticket.closedAt = ts
      ticket.closedReason = clean
      ticket.updatedAt = ts
      writeTicketUnsafe(ticket)

      const actor = by || (ticket.owner && ticket.owner.role) || null
      appendEventUnsafe({
        ts,
        ticketId: id,
        type: 'close',
        by: actor,
        role: actor,
        sessionId: ticket.owner ? ticket.owner.sessionId : null,
        payload: { conclusion: clean },
      })

      return { ticket }
    })
  }

  /** 取一张单 + 最近若干条事件。 */
  function getTicketUnsafe(id, { events = 20 } = {}) {
    const ticket = readTicketRaw(id)
    if (!ticket) throw new StoreError('NOT_FOUND', `没有这张工单：${id}`)
    const limit = Number.isFinite(Number(events)) && Number(events) > 0 ? Math.floor(Number(events)) : 0
    return { ticket, events: readEventsUnsafe(id, limit).events }
  }

  // ── 装配（对外一律返回 {ok...}）──────────────────────────────────────────

  const store = {
    // 只读字段
    dataDir: root,
    ticketsDir,
    workRoot,
    eventsPath,
    indexPath,
    ticketPath,
    workDirOf,

    // 永不 throw
    ensureDirs: guard(() => {
      ensureDirs()
      return { ticketsDir, workRoot }
    }),
    newId: guard((nowArg) => ({ id: newTicketId(Number.isFinite(Number(nowArg)) ? Number(nowArg) : clock()) })),
    openTicket: guard(openTicketUnsafe),
    reportTicket: guard(reportTicketUnsafe),
    attachTicket: guard(attachTicketUnsafe),
    closeTicket: guard(closeTicketUnsafe),
    getTicket: guard(async (id, opts) => getTicketUnsafe(id, opts)),
    readTicket: guard((id) => {
      const ticket = readTicketRaw(id)
      if (!ticket) throw new StoreError('NOT_FOUND', `没有这张工单：${String(id)}`)
      return { ticket }
    }),
    readEvents: guard((id, limit, tailBytes) => readEventsUnsafe(id, limit, tailBytes)),
    listTickets: guard(() => listTicketsUnsafe()),
    readIndex: guard((nowArg) => readIndexUnsafe(nowArg)),
    rebuildIndex: guard((nowArg) => rebuildIndexUnsafe(nowArg)),
    appendEvent: guard(async (event) => appendEventUnsafe(event)),
    runExclusive,
  }

  return store
}
