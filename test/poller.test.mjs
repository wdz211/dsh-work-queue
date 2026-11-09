/**
 * test/poller.test.mjs —— 静默巡检（lib/poller.mjs）的覆盖。
 *
 * 全部假依赖：不建健康账、不读工单目录、不投递任何消息，**绝不碰** `~/.dsh-beta/workqueue`。
 * 时钟一律注入固定值——冷却闸与每小时上限都按时间算，靠真等就是慢测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  diffHealth,
  diffPatterns,
  diffTickets,
  createPoller,
  renderWakeText,
} from '../lib/poller.mjs'

const BASE = Date.parse('2026-11-06T11:00:00.000Z')
const MIN = 60_000

/** 造一条探活 item（只留 diff 用得到的字段）。 */
function h(name, status, failureStreak = 0, detail = `${name} detail`) {
  return { name, status, failureStreak, detail }
}

/** 造一份 scan 结果（形状照 lib/watchdog.mjs 的 scan()：三段是顶层数组）。 */
function scan({ stalled = [], stuck = [], waiting = [] } = {}) {
  return {
    ok: true,
    ts: new Date(BASE).toISOString(),
    stalled,
    stuck,
    waiting,
    counts: { stalled: stalled.length, stuck: stuck.length, waiting: waiting.length },
    unchanged: true,
  }
}

/** 造一条工单 item（字段同 WATCHDOG_ITEM_KEYS 里 diff 用得到的那几个）。 */
function t(id, title = `工单 ${id}`, stageLabel = '搁置', lastOutcome = '') {
  return { id, title, stageLabel, lastOutcome }
}

/** 造一份 patterns 结果。 */
function pats(rows) {
  return { ok: true, patterns: rows }
}

function pattern(problemClass, occurrences, reports = occurrences, ticketIds = []) {
  return { problemClass, occurrences, reports, ticketIds, fixWorthy: occurrences >= 2, needsAttention: occurrences >= 3 }
}

// ── diffHealth：只有两种跃迁值得叫醒 ─────────────────────────────────────

test('diffHealth：ok→warn 不叫（还在容忍区，喊了就是噪音）', () => {
  const events = diffHealth([h('qq-ws', 'ok')], [h('qq-ws', 'warn', 1)])
  assert.equal(events.length, 0)
})

test('diffHealth：warn→critical 叫，key 是 health:<name>', () => {
  const events = diffHealth([h('napcat-port', 'warn', 2, 'TCP 3001 连接失败')], [
    h('napcat-port', 'critical', 3, 'TCP 3001 连接失败'),
  ])
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'health')
  assert.equal(events[0].key, 'health:napcat-port')
  assert.match(events[0].title, /critical/)
  assert.equal(events[0].detail, 'TCP 3001 连接失败')
})

test('diffHealth：一直 critical 不叫（夜间计划停机那种反复上报要被消掉）', () => {
  const events = diffHealth(
    [h('napcat-port', 'critical', 17)],
    [h('napcat-port', 'critical', 18)],
  )
  assert.equal(events.length, 0)
})

test('diffHealth：critical→ok 叫（恢复也要让人知道）', () => {
  const events = diffHealth([h('dsh-port', 'critical', 5)], [h('dsh-port', 'ok', 0)])
  assert.equal(events.length, 1)
  assert.equal(events[0].key, 'health:dsh-port')
  assert.match(events[0].title, /恢复/)
})

test('diffHealth：unknown 不算失败也不算恢复（critical→unknown 不叫）', () => {
  assert.equal(diffHealth([h('x', 'unknown')], [h('x', 'ok')]).length, 0)
  assert.equal(diffHealth([h('x', 'critical', 4)], [h('x', 'unknown', 0)]).length, 0)
  assert.equal(diffHealth([h('x', 'ok')], [h('x', 'unknown', 0)]).length, 0)
})

test('diffHealth：没有基线（null）时一律不叫——首轮建立基线，不开机吵一次', () => {
  assert.equal(diffHealth(null, [h('x', 'critical', 3)]).length, 0)
  assert.equal(diffHealth(undefined, [h('x', 'critical', 3)]).length, 0)
})

// ── diffTickets：只有新进入的成员 ───────────────────────────────────────

test('diffTickets：新进入 stalled 叫一次，第二次 tick 不再叫', () => {
  const result = scan({ stalled: [t('t-1')] })
  const first = diffTickets(new Set(), result)
  assert.equal(first.length, 1)
  assert.equal(first[0].key, 'ticket:t-1:stalled')
  assert.equal(first[0].kind, 'ticket')

  // 把这一轮出来的键当作下一轮的基线：同一张单还在，不重复叫
  const baseline = new Set(first.map((e) => e.key))
  assert.equal(diffTickets(baseline, result).length, 0)
})

test('diffTickets：waiting→stuck 换了段，算新事件（换段意味着状态真变了）', () => {
  const before = new Set(['ticket:t-9:waiting'])
  const events = diffTickets(before, scan({ stuck: [t('t-9', '卡住的单', '卡死')] }))
  assert.equal(events.length, 1)
  assert.equal(events[0].key, 'ticket:t-9:stuck')
})

test('diffTickets：scan 失败（ok:false）不产生事件——读不到不等于没停滞', () => {
  const before = new Set()
  assert.equal(diffTickets(before, { ok: false, code: 'STORE_UNAVAILABLE' }).length, 0)
  assert.equal(diffTickets(before, null).length, 0)
})

test('diffTickets：没有基线不叫', () => {
  assert.equal(diffTickets(null, scan({ stuck: [t('t-1')] })).length, 0)
})

// ── diffPatterns：新 problemClass ───────────────────────────────────────

test('diffPatterns：新 problemClass（≥2 张单）叫一次，之后不再叫', () => {
  const result = pats([pattern('probe-false-positive', 2, 3, ['t-1', 't-2'])])
  const events = diffPatterns(new Set(), result)
  assert.equal(events.length, 1)
  assert.equal(events[0].key, 'pattern:probe-false-positive')
  assert.equal(events[0].kind, 'pattern')
  assert.match(events[0].title, /2 张工单/)

  assert.equal(diffPatterns(new Set(['pattern:probe-false-positive']), result).length, 0)
})

test('diffPatterns：只出现 1 次的只记录不叫（与看门狗分级响应同口径）', () => {
  assert.equal(diffPatterns(new Set(), pats([pattern('偶发一类', 1)])).length, 0)
})

test('diffPatterns：patterns 失败不产生事件', () => {
  assert.equal(diffPatterns(new Set(), { ok: false, code: 'STORE_UNAVAILABLE' }).length, 0)
  assert.equal(diffPatterns(new Set(), pats([]).ok ? { ok: true } : null).length, 0)
})

// ── createPoller ────────────────────────────────────────────────────────

/** 一套可控的假依赖：items / 三段 / patterns 都能逐轮改。 */
function fakeDeps(overrides = {}) {
  const state = {
    items: [h('qq-ws', 'ok')],
    stalled: [],
    stuck: [],
    waiting: [],
    patterns: [],
    checkThrows: false,
    scanThrows: false,
    patternsThrows: false,
  }
  const sent = []
  const deps = {
    health: {
      async check() {
        if (state.checkThrows) throw new Error('探针炸了')
        return { ok: true, ts: new Date(BASE).toISOString(), items: state.items, critical: 0, reportPath: '' }
      },
    },
    watchdog: {
      async scan() {
        if (state.scanThrows) throw new Error('scan 炸了')
        return scan({ stalled: state.stalled, stuck: state.stuck, waiting: state.waiting })
      },
      async patterns() {
        if (state.patternsThrows) throw new Error('patterns 炸了')
        return pats(state.patterns)
      },
    },
    wake: async (text) => {
      sent.push(text)
    },
    log: () => {},
    now: () => BASE,
    ...overrides,
  }
  return { deps, state, sent }
}

test('createPoller：三路全抛异常也不冒泡，tick 正常返回', async () => {
  const { deps, state, sent } = fakeDeps()
  state.checkThrows = true
  state.scanThrows = true
  state.patternsThrows = true
  const poller = createPoller(deps)

  const out = await poller.tick()
  assert.equal(out.events.length, 0)
  assert.equal(sent.length, 0)
})

test('createPoller：一路抛异常不影响另外两路（health 挂了，新工单照样叫）', async () => {
  const { deps, state, sent } = fakeDeps()
  const poller = createPoller(deps)
  await poller.tick() // 首轮只建立基线

  state.checkThrows = true
  state.stalled = [t('t-1')]
  const out = await poller.tick()
  assert.equal(out.events.length, 1)
  assert.equal(out.events[0].key, 'ticket:t-1:stalled')
  assert.equal(sent.length, 1)
})

test('createPoller：不重入——上一轮没跑完就跳过本 tick', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { deps, sent } = fakeDeps({
    health: {
      async check() {
        await gate
        return { ok: true, ts: new Date(BASE).toISOString(), items: [h('qq-ws', 'ok')] }
      },
    },
  })
  const poller = createPoller(deps)

  const first = poller.tick()
  const second = await poller.tick()
  assert.equal(second.skipped, true, '上一个 tick 未完成时应跳过')
  assert.equal(second.events.length, 0)

  release()
  await first
  assert.equal(sent.length, 0)
})

test('createPoller：冷却闸——同一个 key 在冷却期内不重复唤醒', async () => {
  let clock = BASE
  const { deps, state, sent } = fakeDeps({ now: () => clock })
  const poller = createPoller({ ...deps, cooldownMs: 30 * MIN })

  state.items = [h('napcat-port', 'warn', 2)]
  await poller.tick() // 基线：warn

  state.items = [h('napcat-port', 'critical', 3)]
  await poller.tick() // warn → critical：叫
  assert.equal(sent.length, 1)

  state.items = [h('napcat-port', 'ok', 0)]
  await poller.tick() // critical → ok：同一个 key，冷却中 → 不叫
  assert.equal(sent.length, 1)

  clock = BASE + 31 * MIN // 过了冷却期，再有跃迁就该叫
  state.items = [h('napcat-port', 'critical', 3)]
  await poller.tick()
  assert.equal(sent.length, 2)
})

test('createPoller：每小时上限——超出的丢掉，只投一条', async () => {
  const { deps, state, sent } = fakeDeps()
  const poller = createPoller({ ...deps, cooldownMs: 1, maxPerHour: 1 })
  await poller.tick() // 基线

  state.stalled = [t('t-1'), t('t-2')]
  const out = await poller.tick()
  assert.equal(sent.length, 1, '每小时上限 1：只能投出去一条')
  assert.equal(out.events.length, 1)
})

test('createPoller：一次 tick 的多个事件合成一条消息（不一条一条发）', async () => {
  const { deps, state, sent } = fakeDeps()
  const poller = createPoller(deps)
  await poller.tick() // 基线

  state.items = [h('napcat-port', 'ok'), h('dsh-port', 'critical', 3, 'DSH 端口探不通')]
  state.stuck = [t('t-7', '卡死的单', '卡死')]
  state.patterns = [pattern('probe-false-positive', 2, 3, ['t-1', 't-2'])]
  const out = await poller.tick()

  assert.equal(out.events.length, 3)
  assert.equal(sent.length, 1, '三个事件必须并成一条消息')
  const text = sent[0]
  assert.match(text, /\[巡检唤醒\]/)
  assert.match(text, /health: .*dsh-port/)
  assert.match(text, /ticket: 工单 t-7/)
  assert.match(text, /pattern: 复现模式/)
  assert.match(text, /处置口径/)
})

test('createPoller：没有跃迁就不唤醒（噪音为零才是这次重构的目的）', async () => {
  const { deps, state, sent } = fakeDeps()
  const poller = createPoller(deps)
  await poller.tick() // 基线

  state.items = [h('qq-ws', 'ok'), h('napcat-port', 'warn', 1)] // warn 不进跃迁
  state.stalled = [t('t-1')]
  await poller.tick() // 这轮叫（新进入 stalled）
  const before = sent.length
  await poller.tick() // 什么都没变
  assert.equal(sent.length, before)
})

test('createPoller：没有 wake 投递也不抛', async () => {
  const { deps, state } = fakeDeps({ wake: undefined })
  const poller = createPoller(deps)
  await poller.tick()
  state.stalled = [t('t-1')]
  const out = await poller.tick()
  assert.equal(out.events.length, 1)
})

test('createPoller：stop 幂等，start 不叠定时器', () => {
  const { deps } = fakeDeps()
  const poller = createPoller(deps)
  poller.stop()
  poller.stop()
  poller.start(60_000)
  poller.start(60_000)
  poller.stop()
  poller.stop()
  // 不合法间隔：不启动也不抛
  poller.start(0)
  poller.start(-1)
})

// ── 投递失败不许当成功（阻断项：跃迁永久丢失）─────────────────────────────
// 为什么这几条必须存在：index.js 的 deliverWake 在「拿不到 sessionController / 拿不到
// sessions / 没有该 cwd 的 zone / resolveAgent 失败 / flush 抛错」时是 return false 而不是
// throw，而旧实现先记 lastFiredAt 再发、还忽略返回值 —— 投递失败被当成成功，那次跃迁
// 永不补发，表现就是「巡检照跑，一条唤醒都收不到」。

test('createPoller：wake 返回 false 算投递失败——delivered:false 且下一轮重现同一事件', async () => {
  const { deps, state, sent } = fakeDeps({ wake: async () => false })
  const poller = createPoller(deps)
  await poller.tick() // 基线

  state.stalled = [t('t-1')]
  const first = await poller.tick()
  assert.equal(first.delivered, false, '返回 false 必须算失败，不能当成功')
  assert.equal(first.events.length, 1)
  assert.equal(sent.length, 0)

  const second = await poller.tick()
  assert.equal(second.delivered, false)
  assert.equal(second.events.length, 1, '基线没推进、冷却没记 → 同一事件必须再现')
  assert.equal(second.events[0].key, 'ticket:t-1:stalled')
})

test('createPoller：wake 抛错也算投递失败，且不冒泡（tick 不 reject）', async () => {
  const { deps, state } = fakeDeps({
    wake: async () => {
      throw new Error('zone 里没有这个 cwd')
    },
  })
  const poller = createPoller(deps)
  await poller.tick()

  state.stalled = [t('t-1')]
  const first = await poller.tick() // 不 reject 就是这一条断言
  assert.equal(first.delivered, false)
  assert.equal(first.events.length, 1)

  const second = await poller.tick()
  assert.equal(second.events.length, 1, '抛错同样不推进基线，下一轮重试')
})

test('createPoller：wake 成功 → delivered:true，下一轮不再重复同一事件', async () => {
  const { deps, state, sent } = fakeDeps()
  const poller = createPoller(deps)
  await poller.tick()

  state.stalled = [t('t-1')]
  const out = await poller.tick()
  assert.equal(out.delivered, true)
  assert.equal(sent.length, 1)

  const again = await poller.tick()
  assert.equal(again.delivered, null, '没有事件时 delivered 是 null')
  assert.equal(again.events.length, 0)
  assert.equal(sent.length, 1)
})

// ── unknown 对 diff 透明（恢复不丢 / 升级不重报）──────────────────────────

test('createPoller：critical→unknown→ok 三连只在升级与恢复各叫一次，unknown 那轮不叫', async () => {
  let clock = BASE
  const { deps, state, sent } = fakeDeps({ now: () => clock, cooldownMs: 1 })
  const poller = createPoller(deps)

  state.items = [h('napcat-port', 'ok')]
  await poller.tick() // 基线 ok

  state.items = [h('napcat-port', 'critical', 3)]
  await poller.tick() // 第 1 轮：升级
  assert.equal(sent.length, 1)
  assert.match(sent[0], /升级为 critical/)

  state.items = [h('napcat-port', 'unknown', 0)]
  const mid = await poller.tick() // 第 2 轮：unknown —— 既不是升级也不是恢复
  assert.equal(mid.events.length, 0, 'unknown 那轮不许叫')
  assert.equal(sent.length, 1)

  clock = BASE + 10 * MIN // 跨过 1ms 冷却，证明下面这条不是被冷却挡住的
  state.items = [h('napcat-port', 'ok', 0)]
  await poller.tick() // 第 3 轮：恢复
  assert.equal(sent.length, 2, '经 unknown 才恢复也必须报恢复（旧实现这条永久丢失）')
  assert.match(sent[1], /恢复/)
})

test('createPoller：unknown 沿用上一轮已知状态——unknown→critical 不重复报升级', async () => {
  let clock = BASE
  const { deps, state, sent } = fakeDeps({ now: () => clock, cooldownMs: 1 })
  const poller = createPoller(deps)

  state.items = [h('napcat-port', 'ok')]
  await poller.tick()

  state.items = [h('napcat-port', 'critical', 3)]
  await poller.tick() // 升级：叫一次
  assert.equal(sent.length, 1)

  state.items = [h('napcat-port', 'unknown', 0)]
  await poller.tick() // 测不出来：不叫，且基线沿用 critical
  assert.equal(sent.length, 1)

  clock = BASE + 40 * MIN // 冷却早过了：若基线被写成 unknown，这里就会再报一次升级
  state.items = [h('napcat-port', 'critical', 4)]
  const out = await poller.tick()
  assert.equal(out.events.length, 0, 'unknown 不重置升级态，不能重复报升级')
  assert.equal(sent.length, 1)
})

// ── stop() 之后正在进行的轮次不许投递 ─────────────────────────────────────

test('createPoller：stop 之后正在进行的轮次不再投递', async () => {
  let gate = null
  const sent = []
  const state = { items: [h('napcat-port', 'ok')] }
  const poller = createPoller({
    health: {
      async check() {
        if (gate) await gate
        return { ok: true, ts: new Date(BASE).toISOString(), items: state.items }
      },
    },
    wake: async (text) => {
      sent.push(text)
    },
    log: () => {},
    now: () => BASE,
  })

  await poller.tick() // 静默建基线（ok）

  // 造一个会升级的轮次，卡在探针里：模拟 dispose 时正好有一轮在 await
  let release
  gate = new Promise((resolve) => {
    release = resolve
  })
  state.items = [h('napcat-port', 'critical', 3)]
  const inflight = poller.tick()

  poller.stop() // dispose
  release()
  const out = await inflight

  assert.equal(out.skipped, true, 'stop 后醒过来的那一轮必须直接收工')
  assert.equal(sent.length, 0, 'dispose 之后绝不许再往会话里写唤醒')
})

// ── 唤醒文本 ────────────────────────────────────────────────────────────

test('renderWakeText：带本地时间与四条处置口径', () => {
  const text = renderWakeText(
    [{ key: 'health:x', kind: 'health', title: '健康项 x 升级为 critical', detail: '细节' }],
    BASE,
  )
  assert.match(text, /\[巡检唤醒\] 现在 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.match(text, /- health: 健康项 x 升级为 critical —— 细节/)
  assert.match(text, /绝不许重启任何进程，绝不许动 NapCat 或桥接/)
  assert.match(text, /处理完回一行结论即可/)
})
