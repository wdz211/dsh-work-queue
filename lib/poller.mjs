/**
 * lib/poller.mjs —— 静默巡检 + 状态跃迁唤醒（P3）
 *
 * ── 为什么要有这一层 ──────────────────────────────────────────────────────
 * 探活本身是纯代码（`health.check()` / `watchdog.scan()` / `patterns()`），原来却挂在一个
 * 每 30 分钟触发的 cron 上，每轮烧掉一个完整 LLM 回合（48 轮/天、80–100 KB/轮），
 * 而绝大多数轮次只回一句「无异常」。这里把探活搬回进程内，agent 只在**状态真的变了**时
 * 被叫醒——这是降膨胀的唯一手段，所以 diff 判据必须严，不然就把 cron 的噪音搬到这里。
 *
 * ── 三条口径（照 spec）──────────────────────────────────────────────────
 * ① 只有跃迁值得叫醒：health 只在「升到 critical」「从 critical 恢复」时叫，
 *    warn / unknown / 一直 critical / 一直 ok 一律不叫——一条持久故障（链路一直 down）
 *    每小时复述一遍 `napcat-port=critical(17)(18)(19)…` 正是要被消掉的噪音。
 * ② 首轮不叫（`prev*` 为 null 时一律返回空）：刚开机时那条陈年 critical 不是「变化」，
 *    叫醒它只会换来一句「这是老问题」。基线在这一轮静默建立。同理，某一路读失败时
 *    **不推进**该路基线——否则「没读到」会被当成「没异常」，跃迁就被吞掉了。
 * ③ 全链 fail-open：三路各自 try/catch，任何一个抛都不影响其它两路，tick 永不 reject。
 * ④ 投递成功才算数：`wake` 抛错**或返回 false** 都当投递失败——不记冷却、不推进基线，
 *    同一跃迁下一轮自动重现。为什么：`index.js` 的 `deliverWake` 在「拿不到
 *    sessionController / 拿不到 sessions / 没有该 cwd 的 zone / resolveAgent 失败 /
 *    flush 抛错」五种情况下是 `return false` 而不是抛，若把它记成已发，那次跃迁就永久
 *    消失（最坏形态：zone 配错 → 巡检照跑、一条唤醒都收不到）。节流不靠「永不重试」，
 *    靠「每轮一次 + 每小时上限」自然成立。
 * ⑤ unknown 对 diff 透明：探针这一轮「没测出来」时，基线沿用上一轮已知状态（不覆盖）。
 *    否则 `critical → unknown → ok` 的恢复会永久丢失，而 `unknown → critical` 会反复
 *    重报升级——同一处抖动就能把「消噪」这个目的吃掉一半。
 */

import { FIX_MIN_OCCURRENCES } from './watchdog.mjs'

/** 三堆工单的名字（与 `lib/watchdog.mjs` 的 WATCHDOG_SECTIONS 同值，顺序即扫的顺序）。 */
export const TICKET_SECTIONS = Object.freeze(['stalled', 'stuck', 'waiting'])

/** 工单三段的人话名（唤醒消息里给人看）。 */
const SECTION_LABEL = Object.freeze({ stalled: '搁置', stuck: '卡死', waiting: '等待过久' })

const MS_HOUR = 3600_000

// ── 小工具（纯函数）─────────────────────────────────────────────────────

function strOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function numOf(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return strOf(error) || '未知错误'
}

/** 把「上一轮的键集合」归一成 Set；`null`（没有基线）保持 null，让调用方区别对待。 */
function asKeySet(input) {
  if (input instanceof Set) return input
  if (Array.isArray(input)) return new Set(input.map((v) => strOf(v)).filter(Boolean))
  return null
}

/**
 * 取一段工单清单。
 *
 * 真实形状以 `lib/watchdog.mjs` 的 `scan()` 为准：`{ok, ts, stalled, stuck, waiting, …}`
 * ——三段是**顶层数组**，没有 `sections` 包一层。这里顺手兼容一下 `sections` 只是防御，
 * 不是主路径。
 */
function sectionItems(result, key) {
  const direct = result ? result[key] : null
  if (Array.isArray(direct)) return direct
  const nested = result && result.sections ? result.sections[key] : null
  return Array.isArray(nested) ? nested : []
}

/** 一票工单的去重键（spec 明确：`ticket:<id>:<section>`）。 */
function ticketKeyOf(id, section) {
  return `ticket:${id}:${section}`
}

/** 一轮 scan 结果里全部工单键（同一张单在两段里就算两个键，waiting→stuck 因此算新事件）。 */
function ticketKeysOf(scanResult) {
  const keys = new Set()
  for (const section of TICKET_SECTIONS) {
    for (const item of sectionItems(scanResult, section)) {
      const id = strOf(item && item.id)
      if (id) keys.add(ticketKeyOf(id, section))
    }
  }
  return keys
}

/**
 * 一轮 patterns 结果里**够格**的键。
 *
 * 只收 occurrences ≥ FIX_MIN_OCCURRENCES（=2，与看门狗的分级响应同一口径）：
 * 出现 1 次的只记录不报，所以它也不该进基线——否则某一类从 1 张单涨到 2 张单
 * （正是「该修」的那一刻）反而因为「键早就有了」再也叫不出来。
 */
function patternKeysOf(patternsResult) {
  const keys = new Set()
  const rows = patternsResult && Array.isArray(patternsResult.patterns) ? patternsResult.patterns : []
  for (const row of rows) {
    const name = strOf(row && row.problemClass)
    if (!name) continue
    if (numOf(row && row.occurrences) < FIX_MIN_OCCURRENCES) continue
    keys.add(`pattern:${name}`)
  }
  return keys
}

/** 本地时间 `YYYY-MM-DD HH:mm`（唤醒消息里说清「现在」是几点：处置口径第 3 条要用到）。 */
function fmtLocal(ms) {
  const d = new Date(numOf(ms))
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 三条 diff（纯函数，好测）─────────────────────────────────────────────

/**
 * 探活结果的跃迁。
 *
 * @param {Array|null} prevItems 上一轮 `health.check().items`（null = 还没有基线）
 * @param {Array} nextItems 本轮 items
 * @returns {Array<{key:string,kind:string,title:string,detail:string}>}
 */
export function diffHealth(prevItems, nextItems) {
  // 没有基线 → 不叫。首轮那条已经存在的 critical 是「现状」，不是「变化」。
  if (!Array.isArray(prevItems)) return []
  const before = new Map()
  for (const item of prevItems) {
    const name = strOf(item && item.name)
    if (name) before.set(name, strOf(item && item.status))
  }

  const next = Array.isArray(nextItems) ? nextItems : []
  const events = []
  for (const item of next) {
    const name = strOf(item && item.name)
    const to = strOf(item && item.status)
    if (!name || !to) continue
    const from = before.get(name)
    const detail = strOf(item && item.detail) || '（探针没给详情）'

    if (to === 'critical' && from !== 'critical') {
      // 刚升级：连续 3 次失败攒满了，这是唯一需要人知道的探活跃迁
      events.push({
        key: `health:${name}`,
        kind: 'health',
        title: `健康项 ${name} 升级为 critical（连续 ${numOf(item && item.failureStreak)} 次探测失败）`,
        detail,
      })
    } else if (from === 'critical' && to === 'ok') {
      // 恢复也要报：agent 知道它回来了，才会去把之前记的那笔收掉
      events.push({
        key: `health:${name}`,
        kind: 'health',
        title: `健康项 ${name} 从 critical 恢复，现在 ok`,
        detail,
      })
    }
    // warn / unknown / 一直 critical / 一直 ok：不产生事件（消噪的关键）。
    // 注意 critical → unknown 也不叫：unknown 是「测不出来」，不是恢复。
  }
  return events
}

/**
 * 把「这一轮没测出来（unknown）」的探针沿用上一轮的已知状态，供**基线**使用。
 *
 * 为什么不改 `diffHealth`：unknown 在本轮 diff 里本来就不产生事件（它既不是升级也不是恢复），
 * 语义没问题；出问题的是「把 unknown 写进基线」——基线的职责是记住「上一次知道的真相」。
 * 一旦 baseline 被写成 unknown：`critical→unknown→ok` 的恢复永远配不上（from 成了 unknown），
 * `unknown→critical` 又会被判成「刚升级」反复重报。所以只在推进基线时抹掉 unknown，
 * diff 的签名与语义一个字不动。
 */
function carryUnknown(prevItems, nextItems) {
  if (!Array.isArray(nextItems)) return nextItems
  const before = new Map()
  if (Array.isArray(prevItems)) {
    for (const item of prevItems) {
      const name = strOf(item && item.name)
      if (name) before.set(name, strOf(item && item.status))
    }
  }
  return nextItems.map((item) => {
    if (strOf(item && item.status) !== 'unknown') return item
    const kept = before.get(strOf(item && item.name))
    if (!kept || kept === 'unknown') return item // 上一轮也不知道，就还是 unknown
    return { ...item, status: kept }
  })
}

/**
 * 工单三段里**新进入**的成员。
 *
 * @param {Set|Array|null} prevKeys 上一轮的键（null = 还没有基线）
 * @param {object} scanResult `watchdog.scan()` 的返回值
 */
export function diffTickets(prevKeys, scanResult) {
  const before = asKeySet(prevKeys)
  if (!before) return []
  // 读不到工单不等于没有停滞：`ok:false` 时给空事件，绝不假装「无事发生」
  if (!scanResult || scanResult.ok !== true) return []

  const events = []
  for (const section of TICKET_SECTIONS) {
    for (const item of sectionItems(scanResult, section)) {
      const id = strOf(item && item.id)
      if (!id) continue
      const key = ticketKeyOf(id, section)
      if (before.has(key)) continue // 持续存在的单不重复叫
      const stage = strOf(item && item.stageLabel)
      const last = strOf(item && item.lastOutcome)
      const extra = [stage ? `stage=${stage}` : '', last ? `最近报告=${last}` : ''].filter(Boolean).join('，')
      events.push({
        key,
        kind: 'ticket',
        title: `工单 ${id} 进入「${SECTION_LABEL[section] || section}」：${strOf(item && item.title) || '（无标题）'}`,
        detail: extra || '没有更多细节',
      })
    }
  }
  return events
}

/**
 * 复现模式里新出现的 problemClass。
 *
 * @param {Set|Array|null} prevKeys 上一轮的键（null = 还没有基线）
 * @param {object} patternsResult `watchdog.patterns()` 的返回值
 */
export function diffPatterns(prevKeys, patternsResult) {
  const before = asKeySet(prevKeys)
  if (!before) return []
  if (!patternsResult || patternsResult.ok !== true || !Array.isArray(patternsResult.patterns)) return []

  const events = []
  for (const row of patternsResult.patterns) {
    const name = strOf(row && row.problemClass)
    if (!name) continue
    const occurrences = numOf(row && row.occurrences)
    if (occurrences < FIX_MIN_OCCURRENCES) continue // 只出现 1 次的只记录，不叫醒人
    const key = `pattern:${name}`
    if (before.has(key)) continue
    const ids = Array.isArray(row.ticketIds) ? row.ticketIds.filter(Boolean) : []
    const parts = [`报告 ${numOf(row && row.reports)} 次`]
    if (ids.length) parts.push(`工单 ${ids.join('、')}`)
    if (row && row.needsAttention === true) parts.push('需要重视（≥3 张单）')
    events.push({
      key,
      kind: 'pattern',
      title: `复现模式「${name}」已出现在 ${occurrences} 张工单上`,
      detail: parts.join('；'),
    })
  }
  return events
}

// ── 唤醒文本（一次 tick 的多条事件合成一条消息）──────────────────────────

/**
 * 唤醒消息正文。短、带处置口径——让接手的那一轮不用自己猜该干什么，
 * 也避免它再把整份 report 展开成长篇报告（那等于把省下来的膨胀又花回去）。
 */
export function renderWakeText(events, nowMs) {
  const list = Array.isArray(events) ? events : []
  const lines = [`[巡检唤醒] 现在 ${fmtLocal(nowMs)}。以下状态发生变化（来自插件内静默轮询，不是定时任务投递）：`]
  for (const ev of list) lines.push(`- ${strOf(ev && ev.kind)}: ${strOf(ev && ev.title)} —— ${strOf(ev && ev.detail)}`)
  lines.push(
    '',
    '处置口径（照此办，不要展开）：',
    '1) 能自己查能自己改的直接做，做完向工单 work_report 记证据；',
    '2) 需要凭据/账号/人拍板的，用 pending 记一条说明卡在哪一步；',
    '3) 夜间已不关机（计划停机早已废止）：qq-ws / napcat-port 的异常就是真异常，按 LINK-STATUS.md 排查；',
    '4) 绝不许重启任何进程，绝不许动 NapCat 或桥接。',
    '',
    '处理完回一行结论即可，不要长篇报告。',
  )
  return lines.join('\n')
}

// ── 工厂 ────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} [deps.health]   `createHealthLedger()` 的返回值（只用 `.check()`）
 * @param {object} [deps.watchdog] `createWatchdog()` 的返回值（只用 `.scan()` / `.patterns()`）
 * @param {Function} [deps.wake]   投递唤醒：(text) => Promise<any>；由接线层负责真投递
 * @param {object} [deps.log]      cordis logger（有 info/warn/debug 就够）
 * @param {number|Function} [deps.now] 时钟（测试注入固定时间）
 * @param {number} [deps.cooldownMs]   同一 key 多久内不重复唤醒，默认 30 分钟
 * @param {number} [deps.maxPerHour]   每小时最多唤醒几次**事件**，默认 6（计数单位是事件不是
 *   消息：一次 tick 的多个事件合成一条消息投递，但每个事件各占一份额度——偏保守，不算错）
 */
export function createPoller(deps = {}) {
  const opts = deps && typeof deps === 'object' ? deps : {}
  const health = opts.health && typeof opts.health === 'object' ? opts.health : null
  const watchdog = opts.watchdog && typeof opts.watchdog === 'object' ? opts.watchdog : null
  const wake = typeof opts.wake === 'function' ? opts.wake : null
  const cooldownMs = numOf(opts.cooldownMs) > 0 ? numOf(opts.cooldownMs) : 30 * 60_000
  const maxPerHour = numOf(opts.maxPerHour) > 0 ? numOf(opts.maxPerHour) : 6

  function resolveNow() {
    try {
      const raw = typeof opts.now === 'function' ? opts.now() : opts.now
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** 记日志：logger 可能是对象也可能是函数；记日志本身失败绝不能影响巡检。 */
  function say(level, msg) {
    try {
      const log = opts.log
      if (!log) return
      if (typeof log === 'function') {
        log(`[静默巡检] ${msg}`)
        return
      }
      const fn = typeof log[level] === 'function' ? log[level] : (typeof log.info === 'function' ? log.info : null)
      if (typeof fn === 'function') fn.call(log, `[静默巡检] ${msg}`)
    } catch {
      /* 日志只是观察手段，不是功能 */
    }
  }

  let timer = null
  let running = false
  let stopped = false // dispose 之后仍在跑的那一轮不许再投递
  let prevHealth = null // 上一轮 items；null = 还没有基线（首轮静默建立）
  let prevTickets = null // Set
  let prevPatterns = null // Set
  const lastFiredAt = new Map() // key → 上次唤醒时刻（冷却闸）
  const sentAt = [] // 最近一小时内真发出去的时刻（每小时上限）

  /** 停止/被跳过时的一致返回（`delivered:null` = 这一轮压根没尝试投递）。 */
  function skippedResult() {
    return { at: resolveNow(), events: [], delivered: null, skipped: true }
  }

  /**
   * 跑一轮。**永不 reject**（内部全包 try/catch），也永不重入。
   *
   * @returns {Promise<{at:number, events:Array, delivered:(boolean|null), skipped?:boolean}>}
   *   `delivered`：没事件 null / 投递成功 true / 投递失败 false（失败时基线未推进，下一轮重现）
   */
  async function tick() {
    if (running) {
      // 上一轮没跑完就跳过：探针会真的连端口、探 HTTP，叠起来只是并发浪费
      say('debug', '上一轮还没跑完，跳过本次（不重入）')
      return skippedResult()
    }
    running = true
    try {
      // 三路各自 try/catch：任何一路抛都不能影响另外两路，更不能让 tick reject
      let check = null
      try {
        if (health && typeof health.check === 'function') check = await health.check()
      } catch (error) {
        say('warn', `health.check 失败：${messageOf(error)}`)
      }
      if (stopped) return skippedResult()
      let scan = null
      try {
        if (watchdog && typeof watchdog.scan === 'function') scan = await watchdog.scan()
      } catch (error) {
        say('warn', `watchdog.scan 失败：${messageOf(error)}`)
      }
      if (stopped) return skippedResult()
      let pats = null
      try {
        if (watchdog && typeof watchdog.patterns === 'function') pats = await watchdog.patterns()
      } catch (error) {
        say('warn', `watchdog.patterns 失败：${messageOf(error)}`)
      }
      if (stopped) return skippedResult()

      const events = [
        ...diffHealth(prevHealth, check && check.items),
        ...diffTickets(prevTickets, scan),
        ...diffPatterns(prevPatterns, pats),
      ]

      // 下一轮的基线：这里只**算**、不赋值。赋值必须等投递真成功——否则一次投递失败
      // 就把这次跃迁永久吞掉（diff 不会再产出它），等于巡检在跑但一条唤醒都收不到。
      // health 那一路额外过 carryUnknown：这一轮没测出来的探针沿用上一轮已知状态。
      const nextHealth = check && Array.isArray(check.items) ? carryUnknown(prevHealth, check.items) : prevHealth
      const nextTickets = scan && scan.ok === true ? ticketKeysOf(scan) : prevTickets
      const nextPatterns = pats && pats.ok === true ? patternKeysOf(pats) : prevPatterns

      const nowMs = resolveNow()
      const hourAgo = nowMs - MS_HOUR
      while (sentAt.length > 0 && sentAt[0] <= hourAgo) sentAt.shift()

      const due = []
      for (const ev of events) {
        const last = lastFiredAt.get(ev.key)
        if (last !== undefined && nowMs - last < cooldownMs) {
          say('debug', `冷却中（${ev.key}），跳过`)
          continue
        }
        if (sentAt.length + due.length >= maxPerHour) {
          say('warn', `每小时唤醒上限 ${maxPerHour} 次已满，丢弃 ${ev.key}`)
          continue
        }
        due.push(ev)
      }

      if (due.length === 0) {
        // 没有要发的东西：基线照常推进（这一轮读到的东西是有效的）
        prevHealth = nextHealth
        prevTickets = nextTickets
        prevPatterns = nextPatterns
        return { at: nowMs, events: [], delivered: null }
      }
      if (!wake) {
        say('warn', `有 ${due.length} 条跃迁但没配 wake 投递，只记日志（不推进基线，下一轮还会报）`)
        return { at: nowMs, events: due, delivered: false }
      }

      // 真投递。抛错和返回 false 都算失败：`index.js` 的 deliverWake 拿不到 zone /
      // 解析不到 agent / flush 出错时是 `return false`，不抛——漏判这一条就全链哑火。
      let reason = ''
      try {
        if (stopped) return skippedResult() // dispose 时正在进行的那一轮不许再投递
        const result = await wake(renderWakeText(due, nowMs))
        if (result === false) reason = '投递函数返回 false'
      } catch (error) {
        reason = messageOf(error)
      }
      if (reason) {
        // 不记 lastFiredAt / sentAt，也不推进基线 → 同一跃迁下一轮自动重现。
        // 节流不靠「永不重试」，靠「每轮一次 + 每小时上限」自然成立。
        say('warn', `唤醒投递失败（${due.length} 条事件未送达，下一轮重试）：${reason}`)
        return { at: nowMs, events: due, delivered: false }
      }

      // 成功才记冷却与额度：失败记成「已发」会让下一次真投递被自己的冷却挡住
      for (const ev of due) {
        lastFiredAt.set(ev.key, nowMs)
        sentAt.push(nowMs)
      }
      prevHealth = nextHealth
      prevTickets = nextTickets
      prevPatterns = nextPatterns
      return { at: nowMs, events: due, delivered: true }
    } catch (error) {
      say('warn', `本轮巡检整体异常（已吞掉，不影响下一轮）：${messageOf(error)}`)
      return { at: resolveNow(), events: [], delivered: null }
    } finally {
      running = false
    }
  }

  /** 开始定时巡检。`unref()` 保证定时器不拖住进程退出（与其他插件的定时器同一条理由）。 */
  function start(intervalMs) {
    const ms = numOf(intervalMs)
    if (!(ms > 0)) {
      say('warn', `巡检间隔不合法（${intervalMs}），不启动`)
      return
    }
    if (timer) return // 幂等：重复 start 不叠第二个定时器
    stopped = false
    timer = setInterval(() => {
      void tick()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    // 立刻建一次基线：否则启动后头 10 分钟里新发生的异常会在首个 tick 时被吸收成
    // 基线而永不报告（那不是「延迟报告」，是「永久不提」）。这一轮仍然静默。
    void tick()
  }

  /** 停巡检；幂等。 */
  function stop() {
    // 先置位再清定时器：cleanup 时可能有一轮正卡在 await 探针里，它醒过来不许再投递
    stopped = true
    if (!timer) return
    clearInterval(timer)
    timer = null
  }

  return { start, stop, tick }
}
