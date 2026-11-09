/**
 * src/stage.mjs —— 工单 stage 派生与排序。
 *
 * 这个文件是**纯函数**：零 IO、零依赖、**不读时钟**。所有时间都由调用方用 `nowMs` 传入。
 * 为什么这么较真：stage 是工单系统里唯一「随时会被重算」的东西（spec §1.4 明令永不落盘），
 * 派生规则迟早要改。只要它是纯的，改规则就只是改这一个文件——九种状态能在 1 毫秒内跑完，
 * 不用起 DSH、不用造真工单、更不用等两小时去看 idle 到底会不会出现。
 *
 * ⚠️ 本文件被 store.mjs / tools.mjs / 两个测试文件同时 import：`REPORT_OUTCOMES`、`lastOutcome`、
 * `deriveStage`、`compareTickets`、`isOpen`、`STAGE`、`STAGE_LABEL` 都是对外契约，
 * 改签名会同时打断两边。
 *
 * ── 与 p1-spec.md §4 的两处**刻意偏离**（已写进测试，别当 bug 改回去）───────────
 *
 * ① idle 的优先级：spec 的派生表把 `queued`（有 open 无 report）排在 `idle` 之前。
 *    按字面顺序，一张开单后没人管的工单**永远是 queued**，`idle` 这一档可能永远不可达——
 *    而 idle 恰恰是看门狗最该盯的一类（开着、没人动、也没人报错）。
 *    所以这里把 idle 当成 queued/working 的**超时细化**：先判「很久没动」，再判「在做/还没开始」。
 *    失败类信号（waiting-answer / waiting-review / blocked / failed / stuck）仍然压在最前面，
 *    它们不会被 idle 吃掉——这一点与 spec 表格完全一致。
 *
 * ② `lastOutcome` 的取数顺序：spec §3.3 最后一句定了「最终状态 = 该 ticket 最后一条事件」，
 *    所以**事件流优先，ticket 上的 lastReport 只做兜底**。正文是快照、事件是流水，两者不一致时
 *    以流水为准；只有事件流丢了（events.jsonl 被清空）才回落到投影字段。
 */

/** 全部 stage 取值。 */
export const STAGE = Object.freeze({
  WAITING_ANSWER: 'waiting-answer',
  WAITING_REVIEW: 'waiting-review',
  STUCK: 'stuck',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  QUEUED: 'queued',
  WORKING: 'working',
  IDLE: 'idle',
  CLOSED: 'closed',
})

/** `work_report` 认的六种 outcome（spec §3.2 / §5.2）。 */
export const REPORT_OUTCOMES = Object.freeze(['progress', 'ready', 'blocked', 'failed', 'waiting-answer', 'waiting-review'])

const OUTCOME_SET = new Set(REPORT_OUTCOMES)

/** 多久没变化算 idle：2 小时（spec §4）。 */
export const IDLE_AFTER_MS = 2 * 60 * 60 * 1000

/** 连续失败几次算 stuck：3 次（spec §4）。 */
export const STUCK_AFTER_FAILS = 3

/**
 * `work_list` 的默认排序权重（数字越小越靠前）。
 *
 * 顺序理由：`waiting-answer` 排第一是因为它卡在「等我回话」——不处理就永久占着，是唯一
 * 有外部时间压力的状态；`stuck` 排在 `blocked/failed` 前是因为它已经失败到第三次，
 * 再自动重试也没意义了。
 */
const RANK = Object.freeze({
  [STAGE.WAITING_ANSWER]: 0,
  [STAGE.WAITING_REVIEW]: 1,
  [STAGE.STUCK]: 2,
  [STAGE.BLOCKED]: 3,
  [STAGE.FAILED]: 4,
  [STAGE.QUEUED]: 5,
  [STAGE.WORKING]: 6,
  [STAGE.IDLE]: 7,
  [STAGE.CLOSED]: 8,
})

const PRIORITY_RANK = Object.freeze({ p0: 0, p1: 1, p2: 2 })

/** 未知 stage / 未知 priority 的排序值：排最后，绝不假装它是某个已知档。 */
const UNRANKED = 99

/** 解析时间戳；坏值一律当 0（而不是 NaN 传染整个比较）。 */
function tsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return 0
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

/** 未关闭即算「开着」；未知/缺失也算开着（保守：不把不确定当已完成）。 */
export function isOpen(stage) {
  return stage !== STAGE.CLOSED
}

/**
 * 取最近一次 report 的 outcome。
 *
 * 顺序：**事件流（从尾往前扫）→ ticket.lastReport 兜底**。理由见文件头偏离②。
 * 遇到 outcome 认不出来的脏事件会跳过继续往前找，而不是判「没有 report」——
 * 一条脏事件不该让一张已经交付过的单被打回 queued。
 *
 * @param {object} ticket   工单正文（spec §3.2）
 * @param {Array}  [events] 该单的事件列表（spec §3.3）
 * @returns {string|null}
 */
export function lastOutcome(ticket, events = []) {
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (!ev || typeof ev !== 'object' || ev.type !== 'report') continue
      const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
      const outcome = typeof payload.outcome === 'string' && payload.outcome
        ? payload.outcome
        : typeof ev.outcome === 'string' && ev.outcome ? ev.outcome : ''
      if (OUTCOME_SET.has(outcome)) return outcome
    }
  }
  // 兜底：事件流读不到时退回投影字段（store 写的 lastReport 与事件同源，正常情况下两者一致）
  const projected = ticket && typeof ticket === 'object' ? ticket.lastReport : null
  if (projected && typeof projected.outcome === 'string' && OUTCOME_SET.has(projected.outcome)) return projected.outcome
  return null
}

/**
 * 连续失败次数。
 *
 * 权威值是 ticket 上的 `failStreak`（spec §5.2 要求 failed +1、其它清零）。
 * 它缺失时（旧数据、手工写的单）才从事件流倒着数连续 failed。
 */
function failStreakOf(ticket, events) {
  const declared = Number(ticket && ticket.failStreak)
  if (Number.isFinite(declared) && declared >= 0) return Math.floor(declared)
  if (!Array.isArray(events)) return 0
  let streak = 0
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (!ev || typeof ev !== 'object' || ev.type !== 'report') continue
    const payload = ev.payload && typeof ev.payload === 'object' ? ev.payload : {}
    const outcome = typeof payload.outcome === 'string' ? payload.outcome : ''
    if (!OUTCOME_SET.has(outcome)) continue
    if (outcome !== 'failed') break
    streak += 1
  }
  return streak
}

/**
 * 从「事实」推出一个 stage。
 *
 * @param {object} ticket   工单正文（spec §3.2）
 * @param {Array}  [events] 该单的事件列表（lastReport 缺失时用来兜底）
 * @param {number} [nowMs]  当前时间。**必须由调用方给**：本函数不读 Date.now()，
 *                          没给时钟就**不判 idle**（宁可不给这一档，也不拿真时间去猜）
 * @returns {string|null}   null 表示输入不是对象（调用方的错，不假装成 queued）
 */
export function deriveStage(ticket, events = [], nowMs) {
  if (!ticket || typeof ticket !== 'object') return null

  // 1. closed —— 唯一终态，压过一切 report 结论
  if (ticket.closedAt) return STAGE.CLOSED

  const outcome = lastOutcome(ticket, events)

  // 2~6. 「在等人 / 已失败」这一族，与时间无关，也永远不会被 idle 吃掉
  if (outcome === 'waiting-answer') return STAGE.WAITING_ANSWER
  if (outcome === 'waiting-review') return STAGE.WAITING_REVIEW
  if (outcome === 'blocked') return STAGE.BLOCKED
  if (outcome === 'failed') {
    // ★ stuck 必须先于 failed 判：failStreak>=3 的失败不是「失败」，是「卡死」
    return failStreakOf(ticket, events) >= STUCK_AFTER_FAILS ? STAGE.STUCK : STAGE.FAILED
  }

  // 7~9. 只剩「在不在动」。时间维度先看（见文件头偏离①）
  const now = Number(nowMs)
  const stamp = tsOf(ticket.updatedAt) || tsOf(ticket.createdAt)
  if (Number.isFinite(now) && stamp > 0 && now - stamp >= IDLE_AFTER_MS) return STAGE.IDLE

  if (!outcome) return STAGE.QUEUED
  // progress / ready（ready 的降级闸在 store 层，落盘几乎总是 blocked；直接写盘的 ready 照 §4 算 working）
  return STAGE.WORKING
}

/**
 * `work_list` 的排序函数（可直接传给 `Array.prototype.sort`）。
 *
 * 入参必须是**已经带上 `stage`** 的对象（store 的索引会先派生再交给它）。
 * 排序要素依次是：stage 权重 → priority → updatedAt 新的在前 → id 兜底（保证稳定）。
 */
export function compareTickets(a, b) {
  const ra = RANK[a && a.stage] ?? UNRANKED
  const rb = RANK[b && b.stage] ?? UNRANKED
  if (ra !== rb) return ra - rb

  const pa = PRIORITY_RANK[a && a.priority] ?? UNRANKED
  const pb = PRIORITY_RANK[b && b.priority] ?? UNRANKED
  if (pa !== pb) return pa - pb

  const ta = tsOf(a && a.updatedAt)
  const tb = tsOf(b && b.updatedAt)
  if (ta !== tb) return tb - ta

  return String((a && a.id) || '').localeCompare(String((b && b.id) || ''))
}

/** 给工具描述 / 渲染用的中文标签（避免每处都写一遍 switch）。 */
export const STAGE_LABEL = Object.freeze({
  [STAGE.WAITING_ANSWER]: '等我回话',
  [STAGE.WAITING_REVIEW]: '待我审阅',
  [STAGE.STUCK]: '卡死（连续失败 3 次）',
  [STAGE.BLOCKED]: '卡住',
  [STAGE.FAILED]: '失败',
  [STAGE.QUEUED]: '排队中',
  [STAGE.WORKING]: '进行中',
  [STAGE.IDLE]: '搁置（超 2 小时没动）',
  [STAGE.CLOSED]: '已关闭',
})
