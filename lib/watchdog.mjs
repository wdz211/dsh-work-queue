/**
 * lib/watchdog.mjs —— P2b · 看门狗「只读扫描」。
 *
 * 职责边界（一条都不能多）：
 *   · 看：把工单分成 搁置 / 卡死 / 等待过久 三堆，算好每张单停了多久；
 *   · 说：`report()` 把一次扫描结果渲染成 Markdown（**纯函数**，零 IO）；
 *   · **不碰**：不写工单、不发事件、不改 stage、不催办、不派单（P2 明确不自动发起，spec §4.2）。
 *
 * ── 三条硬约束怎么落到代码里 ─────────────────────────────────────────────
 *
 * ① **只读**（spec §1.5 / §3.2）：扫描路径上只调 store 的 `listTickets` / `readEvents`
 *    （拿不到时退回 `readIndex`），一个写方法都没碰。
 *    刻意**不把 `readIndex` 当主路径**：store 的 `readIndex` 在索引过期时会重建并原子写
 *    `index.json` —— 那是一次真实落盘。而 `listTickets` + `readEvents` 一个字节都不写。
 *    stage 也不是我自己另立一套规则：用的就是 store 重建索引时用的同一对纯函数
 *    （`deriveStage` / `lastOutcome`）和同一份输入（ticket 正文 + 该单事件流），
 *    所以结论与 store 的派生逐字段一致（spec §3.1「别自己再算一遍」指的是别另立规则）。
 * ② **时间注入**（spec §1.6）：函数体内没有 `Date.now()`。`nowMs` 可以传数字也可以传函数
 *    （跟 store 的参数风格对齐）；没传就是 `0` —— 此时 `idleForMs` 一律 0、`ts` 为 `''`。
 *    宁可什么都不说，也不偷偷读真实时钟。
 * ③ **空值不落 null**（spec §1.4）：item 的十个字段全是 string/number，空值给 `''` / `0`。
 *
 * ── `unchanged` 到底证明了什么 ───────────────────────────────────────────
 *
 * scan 开头和结尾各对 `tickets/*.json` 做一次内容指纹（逐文件 sha256，再叠一层 sha256，
 * 取前 16 位十六进制）；两次相同才给 `unchanged: true`。它证明的是「我读的时候没有顺手
 * 写脏任何一张单」，**不是**「世界没变」——扫描期间别人改了单，指纹也会变，那时会如实给
 * `false`（spec 说「恒为 true」，但真出现差异还报 true 就等于粉饰，这里不粉饰）。
 * 目录不存在/读不动时指纹是 `''`，两个 `''` 相等 → `true`（没有单可以写脏，这结论也是真的）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  STAGE,
  STAGE_LABEL,
  compareTickets,
  deriveStage,
  lastOutcome,
} from '../src/stage.mjs'

/** 三个清单的名字。顺序即渲染顺序。 */
export const WATCHDOG_SECTIONS = Object.freeze(['stalled', 'stuck', 'waiting'])

/** 多久没动算搁置：2 小时（与 `stage.mjs` 的 `IDLE_AFTER_MS` 同值）。 */
export const IDLE_MS_DEFAULT = 2 * 3600_000

/** 等多久算「等太久」：24 小时（spec §3.3）。 */
export const WAITING_MS_DEFAULT = 24 * 3600_000

const MS_MINUTE = 60_000
const MS_HOUR = 3600_000
const MS_DAY = 86_400_000

/** 清单的展示元信息（emoji 只为一眼区分，不影响任何判定）。 */
const SECTION_META = Object.freeze({
  stalled: Object.freeze({ emoji: '💤', short: '搁置', title: '搁置 · 开着但很久没人动' }),
  stuck: Object.freeze({ emoji: '🧱', short: '卡死', title: '卡死 · 连续失败 3 次' }),
  waiting: Object.freeze({ emoji: '⏳', short: '等待过久', title: '等待过久 · 等我回话 / 待我审阅' }),
})

const REPORT_HEAD = '## 工单看门狗 · 只读扫描'

/** 一份 scan 结果里每个 item 恰好这十个字段（测试逐字段校验，别偷偷加减）。 */
const ITEM_KEYS = Object.freeze([
  'id',
  'title',
  'stage',
  'stageLabel',
  'priority',
  'ownerRole',
  'ownerSessionId',
  'updatedAt',
  'idleForMs',
  'lastOutcome',
])

// ── 小工具（全部纯函数，不读时钟不读盘）──────────────────────────────────

/** 任意值 → 字符串。`null` / `undefined` / 对象一律给 `''`，绝不外泄 null。 */
function strOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 任意值 → 有限数字，坏值给 0（不让 NaN 传染）。 */
function numOf(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 正数才认，否则回落默认值（阈值参数用）。 */
function positiveOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 时间戳字符串 → 毫秒；解析不出来给 0。 */
function tsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return 0
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

/** 毫秒 → ISO 字符串；时钟没注入（0）时给 `''`。 */
function isoOf(now) {
  return Number.isFinite(now) && now > 0 ? new Date(now).toISOString() : ''
}

/** 毫秒 → 人话时长（纯函数，同输入必同输出）。 */
function humanDuration(ms) {
  const n = numOf(ms)
  if (n <= 0) return '刚刚'
  if (n < MS_MINUTE) return '不到 1 分钟'
  const days = Math.floor(n / MS_DAY)
  const hours = Math.floor((n % MS_DAY) / MS_HOUR)
  const mins = Math.floor((n % MS_HOUR) / MS_MINUTE)
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`
  return `${mins} 分`
}

/** 表格单元格：压平换行、转义竖线、空值给破折号。 */
function cell(value) {
  const text = strOf(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim()
  return text || '—'
}

/** 责任人单元格：角色（有 sessionId 时补前 8 位）。 */
function ownerCell(item) {
  const role = strOf(item && item.ownerRole)
  const session = strOf(item && item.ownerSessionId)
  const short = session.length > 8 ? `${session.slice(0, 8)}…` : session
  if (role && short) return `${role} / ${short}`
  return role || short
}

function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return strOf(error) || '未知错误'
}

// ── 内容指纹（证明「我没写脏」的唯一手段）─────────────────────────────────

/**
 * 对 `tickets/*.json` 做内容指纹：逐文件 sha256，按文件名排序后拼起来再 sha256 一次，
 * 取前 16 位。文件名进哈希 → 「新增/删除了工单」也能被发现。
 *
 * 目录不存在 / 读不动 / 里面一张单都没有 → `''`。
 * 「空」统一归一成 `''` 是有意的：store 的只读方法在目录缺失时会顺手 mkdir，
 * 若不归一，一次「本来就没有工单」的扫描会凭空变成「指纹变了」，那是误报。
 *
 * @param {string} ticketsDir
 * @returns {string}
 */
export function fingerprintTickets(ticketsDir) {
  const dir = strOf(ticketsDir)
  if (!dir) return ''
  let names
  try {
    names = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp'))
      .sort()
  } catch {
    return ''
  }
  if (names.length === 0) return ''
  const outer = crypto.createHash('sha256')
  for (const name of names) {
    let digest = 'unreadable'
    try {
      digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')
    } catch {
      /* 读不动就记 unreadable：它同样会改变指纹，正是我们要的敏感度 */
    }
    outer.update(`${name}:${digest}\n`)
  }
  return outer.digest('hex').slice(0, 16)
}

// ── 复现模式（账本整合 A2·分级响应）──────────────────────────────────────

/**
 * 分级响应的两个阈值（照抄错题本 `FIX_MIN_LEVEL = 2` / `needsUserAttention = level >= 3`）：
 *   · 出现 1 次 → 只记录，看门狗不报；
 *   · 出现 ≥2 次 → 进「该修」名单（`🔁 复现模式` 一节）；
 *   · 出现 ≥3 次 → 额外标 `needsAttention: true`（红灯）。
 *
 * **刻意不做的事**：不给模式加寿命（关掉的单也照样计入——spec §2 明令）、不自动修、
 * 不自动派单、不改工单优先级。这里只有"报不报"，没有"动不动"。
 */
export const FIX_MIN_OCCURRENCES = 2
export const ATTENTION_MIN_OCCURRENCES = 3

/** problemClass 的形态：kebab-case（`probe-false-positive`）。空串 = 没分类。 */
export function isKebabCase(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/**
 * 从**事件流现算**复现模式。纯函数：不读盘、不读时钟、不写任何东西、不改入参。
 *
 * 口径（spec §2 表格）：「出现次数」= 该 problemClass 出现在**多少张不同的工单**上。
 * 同一张单报 3 次同一个 class 只算 1 次——否则一张自己反复失败的烂单就能把整类问题
 * 顶成红灯，分级响应就失去意义了。同一张单的重复次数另记在 `reports` 里备查。
 *
 * 只认 `type === 'report'` 的事件（lesson-linked / attach / policy-changed 都不算），
 * 分类取自 `payload.problemClass`（兼容顶层 `problemClass` 的手写事件）。
 *
 * @param {Array} events 全量事件（含已关闭工单的：寿命不加，历史永久保留）
 * @returns {Array<{problemClass:string, occurrences:number, reports:number,
 *                  ticketIds:string[], fixWorthy:boolean, needsAttention:boolean}>}
 *          按 occurrences 降序 → reports 降序 → 名称，**含出现 1 次的**（调用方自行筛）
 */
export function collectProblemPatterns(events) {
  const byClass = new Map()
  const list = Array.isArray(events) ? events : []

  for (const event of list) {
    if (!event || typeof event !== 'object' || event._) continue // 说明行
    if (strOf(event.type) !== 'report') continue
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
    const name = (strOf(payload.problemClass) || strOf(event.problemClass)).trim()
    if (!name) continue
    const ticketId = strOf(event.ticketId)
    if (!ticketId) continue
    let row = byClass.get(name)
    if (!row) {
      row = { problemClass: name, tickets: new Set(), reports: 0 }
      byClass.set(name, row)
    }
    row.tickets.add(ticketId)
    row.reports += 1
  }

  const out = []
  for (const row of byClass.values()) {
    const occurrences = row.tickets.size
    out.push({
      problemClass: row.problemClass,
      occurrences,
      reports: row.reports,
      ticketIds: [...row.tickets].sort(),
      fixWorthy: occurrences >= FIX_MIN_OCCURRENCES,
      needsAttention: occurrences >= ATTENTION_MIN_OCCURRENCES,
    })
  }
  out.sort((a, b) => b.occurrences - a.occurrences
    || b.reports - a.reports
    || a.problemClass.localeCompare(b.problemClass))
  return out
}

// ── 分类（纯函数）────────────────────────────────────────────────────────

/**
 * 把一行（已带 stage）归类到某个清单。纯函数：不看时钟、不读盘。
 *
 * 规则（spec §3.1）：
 *   · `closed` 与「没有 stage」的一律不进清单；
 *   · `idle` → `stalled`（**不再按 idleMs 二次过滤**，stage 已由 stage.mjs 派生过，见 §3.3）；
 *   · `stuck` → `stuck`；
 *   · `waiting-answer` / `waiting-review` 且已等 ≥ waitingMs → `waiting`。
 *
 * 「超过 waitingMs」取 `>=`：与 `stage.mjs` 里 `now - stamp >= IDLE_AFTER_MS` 的边界风格一致，
 * 免得同为阈值判定却一个含端点一个不含。
 *
 * @returns {'stalled'|'stuck'|'waiting'|''}  `''` = 不进任何清单
 */
export function classifyItem(item, waitingMs = WAITING_MS_DEFAULT) {
  if (!item || typeof item !== 'object') return ''
  const stage = strOf(item.stage)
  if (!stage || stage === STAGE.CLOSED) return ''
  if (stage === STAGE.IDLE) return 'stalled'
  if (stage === STAGE.STUCK) return 'stuck'
  const isWaiting = stage === STAGE.WAITING_ANSWER || stage === STAGE.WAITING_REVIEW
  if (!isWaiting) return ''
  return numOf(item.idleForMs) >= positiveOr(waitingMs, WAITING_MS_DEFAULT) ? 'waiting' : ''
}

/**
 * 一行 → 一个 item。**所有字段都是 string 或 number，任何空值都不落 null**（spec §1.4）。
 *
 * `idleThreshold` 只在 store 没给出 stage 时才用得上（兜底分类）；正常路径永远走
 * store 的派生结果，`idleMs` 因此不参与二次过滤（spec §3.3）。
 */
export function buildItem(row, nowMs, idleThreshold = IDLE_MS_DEFAULT) {
  const source = row && typeof row === 'object' ? row : {}
  const updatedAt = strOf(source.updatedAt)
  const stamp = tsOf(updatedAt) || tsOf(source.createdAt)
  const now = numOf(nowMs)
  const idleForMs = now > 0 && stamp > 0 ? Math.max(0, now - stamp) : 0

  let stage = strOf(source.stage)
  if (!stage) stage = idleForMs >= positiveOr(idleThreshold, IDLE_MS_DEFAULT) ? STAGE.IDLE : STAGE.QUEUED

  const owner = source.owner && typeof source.owner === 'object' ? source.owner : {}
  const stageLabel = strOf(STAGE_LABEL[stage]) || stage

  return {
    id: strOf(source.id),
    title: strOf(source.title),
    stage,
    stageLabel,
    priority: strOf(source.priority),
    ownerRole: strOf(owner.role),
    ownerSessionId: strOf(owner.sessionId),
    updatedAt,
    idleForMs,
    lastOutcome: strOf(source.lastOutcome),
  }
}

// ── 读 store（只读，永不 throw）───────────────────────────────────────────

/** 安全地调一个 store 读方法：方法缺失/抛错/返回坏形状 → `null`。 */
async function safeRead(store, method, ...args) {
  if (!store || typeof store[method] !== 'function') return null
  try {
    const result = await store[method](...args)
    return result && typeof result === 'object' ? result : null
  } catch {
    return null
  }
}

/** 一次读全部事件，按 ticketId 分组（与 store 重建索引时的 `groupEvents` 同口径）。 */
async function loadEvents(store) {
  const byId = new Map()
  const read = await safeRead(store, 'readEvents', null, 0)
  const events = read && read.ok === true && Array.isArray(read.events) ? read.events : []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const id = strOf(event.ticketId)
    if (!id) continue
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(event)
  }
  return byId
}

/**
 * 取「行」列表：优先 listTickets + 本地派生（零写入），失败才退回 readIndex。
 * 两条路都不通 → 返回 `null`（调用方会回 ok:false，绝不假装「无停滞」）。
 */
async function collectRows(store, now) {
  const listed = await safeRead(store, 'listTickets')
  if (listed && listed.ok === true && Array.isArray(listed.tickets)) {
    const eventsById = await loadEvents(store)
    return listed.tickets
      .filter((ticket) => ticket && typeof ticket === 'object' && !ticket.closedAt)
      .map((ticket) => {
        const id = strOf(ticket.id)
        const events = eventsById.get(id) || []
        return {
          id,
          title: ticket.title,
          stage: deriveStage(ticket, events, now),
          priority: ticket.priority,
          owner: ticket.owner,
          updatedAt: ticket.updatedAt,
          createdAt: ticket.createdAt,
          lastOutcome: lastOutcome(ticket, events),
          closedAt: ticket.closedAt || '',
        }
      })
  }

  // 退化路径：listTickets 挂了才碰 readIndex。注意它可能重建并写 index.json ——
  // 那是缓存不是工单，而且只在主路径失效时才发生（spec §3.2 本身就允许 readIndex）。
  const indexed = await safeRead(store, 'readIndex', now)
  if (indexed && indexed.ok === true && indexed.index && Array.isArray(indexed.index.tickets)) {
    return indexed.index.tickets
      .filter((row) => row && typeof row === 'object' && !row.closedAt)
      .map((row) => ({ ...row }))
  }
  return null
}

// ── 渲染（纯函数）────────────────────────────────────────────────────────

/**
 * `report(result)`：把 scan 结果渲染成 Markdown。**纯函数**——不读盘、不读时钟、
 * 不改入参（测试会把入参 deepFreeze 后调它来证明这一点）。
 *
 * @param {object} result scan 的返回值
 * @returns {string}
 */
export function renderReport(result) {
  if (!result || typeof result !== 'object') {
    return `${REPORT_HEAD}\n\n（没有扫描结果：report() 收到空输入，什么都没发生。）\n`
  }

  if (result.ok !== true) {
    const code = strOf(result.code) || 'UNKNOWN'
    const message = strOf(result.message) || '（没有错误描述）'
    return `${REPORT_HEAD}\n\n扫描失败：\`${code}\` ${message}\n`
  }

  const groups = WATCHDOG_SECTIONS.map((key) => ({
    key,
    items: Array.isArray(result[key]) ? result[key] : [],
  }))
  const total = groups.reduce((sum, group) => sum + group.items.length, 0)
  const stamp = strOf(result.ts) || '（未注入时钟）'
  const countsLine = groups
    .map((group) => `${SECTION_META[group.key].short} ${group.items.length}`)
    .join(' · ')

  const out = [`${REPORT_HEAD} · ${stamp}`, '', `计数：${countsLine}（共 ${total} 张）`, '']

  if (total === 0) {
    out.push('无停滞：没有搁置、没有卡死、没有等待过久的工单。')
  } else {
    for (const group of groups) {
      if (group.items.length === 0) continue
      const meta = SECTION_META[group.key]
      out.push(`### ${meta.emoji} ${meta.title} · ${group.items.length} 张`)
      out.push('')
      out.push('| id | 标题 | 优先级 | 责任人 | 停了多久 | 最近报告 |')
      out.push('|---|---|---|---|---|---|')
      for (const item of group.items) {
        const row = [
          `\`${cell(item && item.id)}\``,
          cell(item && item.title),
          cell(item && item.priority),
          ownerCell(item),
          humanDuration(item && item.idleForMs),
          cell(item && item.lastOutcome),
        ]
        out.push(`| ${row.join(' | ')} |`)
      }
      out.push('')
    }
  }

  // 复现模式：只有出现 ≥2 次的才进这一节（出现 1 次只记录，不报 —— spec §2）
  const patterns = (Array.isArray(result.patterns) ? result.patterns : [])
    .filter((row) => row && typeof row === 'object' && numOf(row.occurrences) >= FIX_MIN_OCCURRENCES)
  if (patterns.length > 0) {
    const red = patterns.filter((row) => row.needsAttention === true).length
    out.push(`### 🔁 复现模式 · ${patterns.length} 类${red > 0 ? `（其中 ${red} 类需要重视）` : ''}`)
    out.push('')
    out.push('| problemClass | 几张单 | 报告次数 | 判定 | 工单 |')
    out.push('|---|---|---|---|---|')
    for (const row of patterns) {
      const verdict = row.needsAttention === true ? '需要重视（≥3 次）' : '该修（≥2 次）'
      const ids = Array.isArray(row.ticketIds) && row.ticketIds.length > 0
        ? row.ticketIds.map((id) => `\`${cell(id)}\``).join(' ')
        : '—'
      out.push(`| \`${cell(row.problemClass)}\` | ${numOf(row.occurrences)} | ${numOf(row.reports)} | ${verdict} | ${ids} |`)
    }
    out.push('')
    out.push('> 复现模式是从事件流**现算**的（不落盘、不加寿命、不自动修）；关掉的单照样计入。')
    out.push('')
  }

  const unchanged = result.unchanged === true ? 'true' : 'false'
  out.push(`> 只读校验：扫描前后工单文件指纹一致 = ${unchanged}（本模块不写任何工单）。`)
  return `${out.join('\n')}\n`
}

// ── 工厂 ────────────────────────────────────────────────────────────────

/**
 * 创建看门狗。
 *
 * @param {object}   [options]
 * @param {object}   [options.store]       store 实例（只调它的读方法）
 * @param {number|Function} [options.nowMs] 当前时间（数字或函数；不读真实时钟）
 * @param {number}   [options.idleMs]     仅供兜底分类与对外一致性（spec §3.3 不做二次过滤）
 * @param {number}   [options.waitingMs]  等待多久算过久，默认 24h
 * @returns {{ scan: Function, report: Function }}
 */
export function createWatchdog(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const store = opts.store && typeof opts.store === 'object' ? opts.store : null
  const clockSource = opts.nowMs
  const defaultIdleMs = positiveOr(opts.idleMs, IDLE_MS_DEFAULT)
  const defaultWaitingMs = positiveOr(opts.waitingMs, WAITING_MS_DEFAULT)

  /** 取当前时间；没注入/坏值一律 0（= 不判时间，绝不偷读 Date.now）。 */
  function resolveNow() {
    let raw
    try {
      raw = typeof clockSource === 'function' ? clockSource() : clockSource
    } catch {
      return 0
    }
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : 0
  }

  /**
   * 跑一次只读扫描。
   *
   * @param {{idleMs?:number, waitingMs?:number}} [scanOptions]
   * @returns {Promise<{ok:true, ts:string, stalled:Array, stuck:Array, waiting:Array,
   *                    counts:{stalled:number,stuck:number,waiting:number}, unchanged:boolean}>}
   */
  async function scan(scanOptions = {}) {
    try {
      const perCall = scanOptions && typeof scanOptions === 'object' ? scanOptions : {}
      const idleMs = positiveOr(perCall.idleMs, defaultIdleMs)
      const waitingMs = positiveOr(perCall.waitingMs, defaultWaitingMs)
      const now = resolveNow()

      const ticketsDir = strOf(store && store.ticketsDir)
      const before = fingerprintTickets(ticketsDir)

      const rows = await collectRows(store, now)
      if (!rows) {
        return {
          ok: false,
          code: 'STORE_UNAVAILABLE',
          message: '读不到工单（store 未提供 listTickets/readIndex，或两者都失败）——不假装「无停滞」',
        }
      }

      const buckets = { stalled: [], stuck: [], waiting: [] }
      for (const row of rows) {
        const item = buildItem(row, now, idleMs)
        const section = classifyItem(item, waitingMs)
        if (section) buckets[section].push(item)
      }
      for (const key of WATCHDOG_SECTIONS) buckets[key].sort(compareTickets)

      const after = fingerprintTickets(ticketsDir)

      return {
        ok: true,
        ts: isoOf(now),
        stalled: buckets.stalled,
        stuck: buckets.stuck,
        waiting: buckets.waiting,
        counts: {
          stalled: buckets.stalled.length,
          stuck: buckets.stuck.length,
          waiting: buckets.waiting.length,
        },
        unchanged: before === after,
      }
    } catch (error) {
      return {
        ok: false,
        code: 'SCAN_FAILED',
        message: `看门狗扫描异常（未写任何工单）：${messageOf(error)}`,
      }
    }
  }

  /** 渲染扫描结果。纯函数：同输入必同输出，不读盘、不碰时钟。 */
  function report(result) {
    try {
      return renderReport(result)
    } catch (error) {
      return `${REPORT_HEAD}\n\n（渲染失败：${messageOf(error)}）\n`
    }
  }

  /**
   * 复现模式：**只读**——只调 `store.readEvents`（它连 mkdir 都不做），
   * 一个字节都不写，也不缓存。次数每次都现算，所以没有"状态过期"这种问题。
   *
   * 读不到事件流时返回 `ok:false` 而**不是空数组**：空数组会被读成"没有复现问题"，
   * 那是把"看不见"粉饰成"没问题"。
   *
   * @returns {Promise<{ok:true, patterns:Array}|{ok:false, code:string, message:string}>}
   */
  async function patterns() {
    try {
      const read = await safeRead(store, 'readEvents', null, 0)
      if (!read || read.ok !== true || !Array.isArray(read.events)) {
        return {
          ok: false,
          code: 'STORE_UNAVAILABLE',
          message: '读不到事件流（store 未提供 readEvents，或它失败了）——不假装「没有复现问题」',
        }
      }
      return { ok: true, patterns: collectProblemPatterns(read.events) }
    } catch (error) {
      return { ok: false, code: 'PATTERN_FAILED', message: `复现模式统计异常（未写任何文件）：${messageOf(error)}` }
    }
  }

  return { scan, report, patterns }
}

/** 供接线层/测试核对字段集合用（只读常量）。 */
export const WATCHDOG_ITEM_KEYS = ITEM_KEYS

/** 一条复现模式的字段集合（数量固定六个，别偷偷加减 —— output schema 按它登记）。 */
export const WATCHDOG_PATTERN_KEYS = Object.freeze([
  'problemClass',
  'occurrences',
  'reports',
  'ticketIds',
  'fixWorthy',
  'needsAttention',
])
