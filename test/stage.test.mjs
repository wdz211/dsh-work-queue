/**
 * test/stage.test.mjs —— stage 派生与排序的全覆盖。
 *
 * 设计原则：所有用例都用**固定时钟** `NOW`，不读真实时间。这样「2 小时算 idle」这类
 * 时间相关的判定可以被精确验证，而不是靠 sleep 或大概齐 —— 也因为 deriveStage 本身
 * 不读 Date.now()，注入时钟才可能精确。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  IDLE_AFTER_MS,
  REPORT_OUTCOMES,
  STAGE,
  STUCK_AFTER_FAILS,
  compareTickets,
  deriveStage,
  isOpen,
  lastOutcome,
} from '../src/stage.mjs'

/** 固定「现在」。 */
const NOW = Date.parse('2026-11-04T12:00:00.000Z')

/** 造一张工单；默认是刚开的、还没任何 report 的空单。 */
function mkTicket(over = {}) {
  return {
    id: 't-test0001',
    title: '测试单',
    kind: 'manual',
    priority: 'p1',
    owner: { role: 'lead', sessionId: 'session-a' },
    createdAt: new Date(NOW - 1000).toISOString(),
    updatedAt: new Date(NOW - 1000).toISOString(),
    closedAt: null,
    closedReason: null,
    lastReport: null,
    reports: 0,
    failStreak: 0,
    ...over,
  }
}

/** 造一张「最后一条 report 是某 outcome」的工单（只写投影字段，不造事件）。 */
function withOutcome(outcome, extra = {}) {
  return mkTicket({
    lastReport: { outcome, evidence: 'ev', note: '', at: new Date(NOW - 500).toISOString() },
    reports: 1,
    ...extra,
  })
}

/** 造一条 report 事件。 */
function reportEvent(outcome, ts = NOW - 500, extra = {}) {
  return { ts: new Date(ts).toISOString(), ticketId: 't-test0001', type: 'report', payload: { outcome, ...extra } }
}

// ── 输入健壮性 ────────────────────────────────────────────────────────────

test('非对象输入返回 null，不抛异常', () => {
  assert.equal(deriveStage(null, [], NOW), null)
  assert.equal(deriveStage(undefined, [], NOW), null)
  assert.equal(deriveStage('str', [], NOW), null)
  assert.equal(deriveStage(42, [], NOW), null)
})

test('events 不是数组时安全降级（按没有事件处理）', () => {
  assert.equal(lastOutcome(mkTicket(), null), null)
  assert.equal(lastOutcome(mkTicket(), 'nope'), null)
  assert.equal(deriveStage(mkTicket(), null, NOW), STAGE.QUEUED)
})

// ── 九种 stage 全覆盖 ────────────────────────────────────────────────────

test('closedAt 有值 → closed（压过一切其他信号）', () => {
  // 即便同时带着 failed 的报告，关闭就是关闭
  const t = withOutcome('failed', {
    failStreak: 5,
    closedAt: new Date(NOW - 100).toISOString(),
    closedReason: '做完了',
  })
  assert.equal(deriveStage(t, [], NOW), STAGE.CLOSED)
  // 也压过「等我回话」
  const t2 = withOutcome('waiting-answer', { closedAt: new Date(NOW - 100).toISOString() })
  assert.equal(deriveStage(t2, [], NOW), STAGE.CLOSED)
})

test('waiting-answer → waiting-answer', () => {
  assert.equal(deriveStage(withOutcome('waiting-answer'), [], NOW), STAGE.WAITING_ANSWER)
})

test('waiting-review → waiting-review', () => {
  assert.equal(deriveStage(withOutcome('waiting-review'), [], NOW), STAGE.WAITING_REVIEW)
})

test('blocked → blocked', () => {
  assert.equal(deriveStage(withOutcome('blocked'), [], NOW), STAGE.BLOCKED)
})

test('failed 且失败次数不足 3 → failed', () => {
  assert.equal(deriveStage(withOutcome('failed', { failStreak: 0 }), [], NOW), STAGE.FAILED)
  assert.equal(deriveStage(withOutcome('failed', { failStreak: 1 }), [], NOW), STAGE.FAILED)
  assert.equal(deriveStage(withOutcome('failed', { failStreak: 2 }), [], NOW), STAGE.FAILED)
})

test('failed 且连续失败达到 3 → stuck（而不是 failed）', () => {
  assert.equal(STUCK_AFTER_FAILS, 3, '阈值变了就要同步改这个断言')
  assert.equal(deriveStage(withOutcome('failed', { failStreak: 3 }), [], NOW), STAGE.STUCK)
  assert.equal(deriveStage(withOutcome('failed', { failStreak: 9 }), [], NOW), STAGE.STUCK)
})

test('failStreak 缺失或非数字时按 0 处理，不该变成 stuck', () => {
  assert.equal(deriveStage(withOutcome('failed', { failStreak: undefined }), [], NOW), STAGE.FAILED)
  assert.equal(deriveStage(withOutcome('failed', { failStreak: 'abc' }), [], NOW), STAGE.FAILED)
})

test('failStreak 缺失时，从事件流数连续 failed（旧数据兜底）', () => {
  const t = mkTicket({ lastReport: null, failStreak: undefined, reports: 3 })
  const events = [
    { type: 'open', payload: {} },
    reportEvent('failed'),
    reportEvent('failed'),
    reportEvent('failed'),
  ]
  assert.equal(deriveStage(t, events, NOW), STAGE.STUCK)
})

test('刚开、没有任何 report → queued', () => {
  assert.equal(deriveStage(mkTicket(), [], NOW), STAGE.QUEUED)
})

test('progress → working', () => {
  assert.equal(deriveStage(withOutcome('progress'), [], NOW), STAGE.WORKING)
})

test('ready → working（降级闸在 store 层，派生层只管已落盘的事实）', () => {
  assert.equal(deriveStage(withOutcome('ready'), [], NOW), STAGE.WORKING)
})

// ── idle 三条（文件头「刻意偏离①」的守护用例）────────────────────────────

test('★ 开单后超 2 小时没动 → idle（而不是永远 queued）', () => {
  const fresh = mkTicket()
  const stale = mkTicket({ updatedAt: new Date(NOW - IDLE_AFTER_MS - 1000).toISOString() })
  assert.equal(deriveStage(fresh, [], NOW), STAGE.QUEUED, '刚开的是 queued')
  assert.equal(deriveStage(stale, [], NOW), STAGE.IDLE, '超 2 小时没动必须能命中 idle')
})

test('★ progress 但超 2 小时没再更新 → idle（而不是一直 working）', () => {
  const stale = withOutcome('progress', { updatedAt: new Date(NOW - IDLE_AFTER_MS - 1000).toISOString() })
  assert.equal(deriveStage(stale, [], NOW), STAGE.IDLE)
})

test('★ 失败类信号优先于时间：blocked 放了两天仍然是 blocked，不会被 idle 吃掉', () => {
  const old = withOutcome('blocked', { updatedAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString() })
  assert.equal(deriveStage(old, [], NOW), STAGE.BLOCKED)
  const oldWaiting = withOutcome('waiting-answer', { updatedAt: new Date(NOW - 9 * 24 * 60 * 60 * 1000).toISOString() })
  assert.equal(deriveStage(oldWaiting, [], NOW), STAGE.WAITING_ANSWER)
})

test('idle 的边界是 >= 2 小时', () => {
  const edge = mkTicket({ updatedAt: new Date(NOW - IDLE_AFTER_MS).toISOString() })
  assert.equal(deriveStage(edge, [], NOW), STAGE.IDLE, '刚好 2 小时算 idle')
  const just = mkTicket({ updatedAt: new Date(NOW - IDLE_AFTER_MS + 1000).toISOString() })
  assert.equal(deriveStage(just, [], NOW), STAGE.QUEUED, '差 1 秒不算 idle')
})

test('★ idle 判定只认真传入的 nowMs：同一个单换个 nowMs 结论就变（证明没读 Date.now）', () => {
  const t = mkTicket({ updatedAt: new Date(NOW).toISOString() })
  // 同一张单、同一份事件，只改 nowMs
  assert.equal(deriveStage(t, [], NOW), STAGE.QUEUED, '此刻还没超时')
  assert.equal(deriveStage(t, [], NOW + IDLE_AFTER_MS), STAGE.IDLE, '把时钟推后 2 小时就该超时')
  // 反过来：时钟拨回很久以前，永远不该判 idle
  assert.equal(deriveStage(t, [], NOW - 365 * 24 * 60 * 60 * 1000), STAGE.QUEUED)
})

test('★ 不给 nowMs 时不判 idle（函数不自己读钟）', () => {
  const stale = mkTicket({ updatedAt: new Date(NOW - IDLE_AFTER_MS - 1000).toISOString() })
  assert.equal(deriveStage(stale, []), STAGE.QUEUED, '没有时钟就只能当作"还没超时"')
  assert.equal(deriveStage(stale, [], undefined), STAGE.QUEUED)
})

test('时间戳坏掉时不误判 idle', () => {
  const t = mkTicket({ createdAt: 'not-a-date', updatedAt: 'also-bad' })
  assert.equal(deriveStage(t, [], NOW), STAGE.QUEUED)
})

test('updatedAt 缺失时用 createdAt 兜底判 idle', () => {
  const t = mkTicket({
    updatedAt: undefined,
    createdAt: new Date(NOW - IDLE_AFTER_MS - 1000).toISOString(),
  })
  assert.equal(deriveStage(t, [], NOW), STAGE.IDLE)
})

// ── lastOutcome：事件流优先，投影字段兜底（spec §3.3）─────────────────────

test('★ 事件流优先于 ticket.lastReport（spec §3.3：最终状态 = 最后一条事件）', () => {
  const t = withOutcome('blocked')
  const events = [reportEvent('progress')]
  assert.equal(lastOutcome(t, events), 'progress', '事件说 progress 就是 progress')
  assert.equal(deriveStage(t, events, NOW), STAGE.WORKING)
})

test('事件流读不到时才用 lastReport 兜底', () => {
  const t = withOutcome('waiting-answer')
  assert.equal(lastOutcome(t, []), 'waiting-answer')
  assert.equal(deriveStage(t, [], NOW), STAGE.WAITING_ANSWER)
})

test('取最后一条 report（不是第一条），并跳过 open/attach/close 事件', () => {
  const t = mkTicket({ lastReport: null })
  const events = [
    { type: 'open', payload: {} },
    reportEvent('progress'),
    { type: 'attach', payload: {} },
    reportEvent('waiting-review'),
  ]
  assert.equal(lastOutcome(t, events), 'waiting-review')
  assert.equal(deriveStage(t, events, NOW), STAGE.WAITING_REVIEW)
})

test('脏事件（outcome 不认识）跳过继续往前找，不把单打回 queued', () => {
  const t = mkTicket({ lastReport: null })
  const events = [reportEvent('progress'), reportEvent('no-such-outcome')]
  assert.equal(lastOutcome(t, events), 'progress')
  assert.equal(deriveStage(t, events, NOW), STAGE.WORKING)
})

test('REPORT_OUTCOMES 就是 spec §3.2 的六种', () => {
  assert.deepEqual(
    [...REPORT_OUTCOMES].sort(),
    ['blocked', 'failed', 'progress', 'ready', 'waiting-answer', 'waiting-review'],
  )
})

// ── 排序 ─────────────────────────────────────────────────────────────────

test('排序：waiting-answer 最先，closed 最后', () => {
  const at = new Date(NOW).toISOString()
  const list = [
    { id: 'a', stage: STAGE.CLOSED, priority: 'p0', updatedAt: at },
    { id: 'b', stage: STAGE.WAITING_ANSWER, priority: 'p2', updatedAt: at },
    { id: 'c', stage: STAGE.IDLE, priority: 'p0', updatedAt: at },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['b', 'c', 'a'])
})

test('排序：完整九档顺序 = §4 那张排序表', () => {
  const at = new Date(NOW).toISOString()
  const expected = [
    STAGE.WAITING_ANSWER,
    STAGE.WAITING_REVIEW,
    STAGE.STUCK,
    STAGE.BLOCKED,
    STAGE.FAILED,
    STAGE.QUEUED,
    STAGE.WORKING,
    STAGE.IDLE,
    STAGE.CLOSED,
  ]
  // 故意打乱输入顺序
  const shuffled = [STAGE.CLOSED, STAGE.WORKING, STAGE.STUCK, STAGE.IDLE, STAGE.QUEUED,
    STAGE.FAILED, STAGE.WAITING_ANSWER, STAGE.BLOCKED, STAGE.WAITING_REVIEW]
  const list = shuffled.map((stage, i) => ({ id: `x${i}`, stage, priority: 'p1', updatedAt: at })).sort(compareTickets)
  assert.deepEqual(list.map((x) => x.stage), expected)
})

test('排序：stuck 排在 blocked 和 failed 之前（失败越重越靠前）', () => {
  const at = new Date(NOW).toISOString()
  const list = [
    { id: 'failed', stage: STAGE.FAILED, priority: 'p1', updatedAt: at },
    { id: 'blocked', stage: STAGE.BLOCKED, priority: 'p1', updatedAt: at },
    { id: 'stuck', stage: STAGE.STUCK, priority: 'p1', updatedAt: at },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['stuck', 'blocked', 'failed'])
})

test('排序：同一 stage 内按 priority p0→p1→p2', () => {
  const at = new Date(NOW).toISOString()
  const list = [
    { id: 'p2', stage: STAGE.WORKING, priority: 'p2', updatedAt: at },
    { id: 'p0', stage: STAGE.WORKING, priority: 'p0', updatedAt: at },
    { id: 'p1', stage: STAGE.WORKING, priority: 'p1', updatedAt: at },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['p0', 'p1', 'p2'])
})

test('排序：同 stage 同 priority 时，更新的在前', () => {
  const list = [
    { id: 'old', stage: STAGE.WORKING, priority: 'p1', updatedAt: new Date(NOW - 100000).toISOString() },
    { id: 'new', stage: STAGE.WORKING, priority: 'p1', updatedAt: new Date(NOW).toISOString() },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['new', 'old'])
})

test('排序：未知 stage / 未知 priority 不炸，排到最后', () => {
  const at = new Date(NOW).toISOString()
  const list = [
    { id: 'weird', stage: 'no-such-stage', priority: 'p1', updatedAt: at },
    { id: 'ok', stage: STAGE.QUEUED, priority: 'p1', updatedAt: at },
    { id: 'weirdPrio', stage: STAGE.QUEUED, priority: 'p9', updatedAt: at },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['ok', 'weirdPrio', 'weird'])
})

test('排序：坏时间戳当 0 处理，不产 NaN', () => {
  const list = [
    { id: 'bad', stage: STAGE.QUEUED, priority: 'p1', updatedAt: 'not-a-date' },
    { id: 'good', stage: STAGE.QUEUED, priority: 'p1', updatedAt: new Date(NOW).toISOString() },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['good', 'bad'])
})

test('排序是稳定的：全同要素时按 id 兜底', () => {
  const at = new Date(NOW).toISOString()
  const list = [
    { id: 'zzz', stage: STAGE.QUEUED, priority: 'p1', updatedAt: at },
    { id: 'aaa', stage: STAGE.QUEUED, priority: 'p1', updatedAt: at },
  ].sort(compareTickets)
  assert.deepEqual(list.map((x) => x.id), ['aaa', 'zzz'])
})

test('compareTickets 不吃 null / undefined', () => {
  assert.doesNotThrow(() => [null, {}, { stage: STAGE.QUEUED }].sort(compareTickets))
})

// ── isOpen ───────────────────────────────────────────────────────────────

test('isOpen：只有 closed 算关闭', () => {
  assert.equal(isOpen(STAGE.CLOSED), false)
  for (const s of Object.values(STAGE)) {
    if (s !== STAGE.CLOSED) assert.equal(isOpen(s), true, `${s} 应当是打开状态`)
  }
  // 未知 stage 保守地算开着（不把不确定当已完成）
  assert.equal(isOpen('no-such-stage'), true)
})
