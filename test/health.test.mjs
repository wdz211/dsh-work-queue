/**
 * test/health.test.mjs —— M4 健康账的行为闸
 *
 * 铁律：**只用假探针 + os.tmpdir()**。这里一个真实端口都不连、一个真实状态文件都不读，
 * 更不许碰 ~\.dsh-beta\workqueue。所有落盘都发生在 mkdtemp 出来的临时目录里，after() 清掉。
 *
 * 覆盖（§8 验收③ + §6.2 的三态语义）：
 *   1. 连续 3 次失败才升 critical，第 1/2 次只是 warn；
 *   2. 中途成功一次 → 计数归零，再失败得重新数满 3；
 *   3. ok:null 连来 5 次 → unknown、critical=0（unknown 不算失败）；
 *   4. 探针自己抛异常 → 捕获成 unknown，整次 check 不挂；
 *   5. report.md 有表头与「连续失败」字样；health.jsonl 每次一行；
 *   6. 一个探针挂掉不影响其它项。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CRITICAL_THRESHOLD,
  MONITOR_NAMES,
  buildReportMarkdown,
  createHealthLedger,
  createRealProbes,
} from '../src/health.mjs'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-health-'))
let dirSeq = 0

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {}
})

/** 每个用例一个独立 dataDir：health.jsonl 里的计数不会被别的用例污染 */
function mkDataDir(label) {
  dirSeq += 1
  const dir = path.join(TMP_ROOT, `${label}-${dirSeq}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 一套全绿的假探针，用例按需覆盖其中几项 */
function healthyProbes() {
  const probes = {}
  for (const name of MONITOR_NAMES) probes[name] = async () => ({ ok: true, detail: `${name} 正常` })
  return probes
}

function itemOf(result, name) {
  const item = result.items.find((i) => i.name === name)
  assert.ok(item, `结果里应该有 ${name}`)
  return item
}

const NOW = Date.parse('2026-11-04T06:20:00.000Z')

test('连续 3 次失败：第 1、2 次 warn（critical=0），第 3 次 critical（critical=1）', async () => {
  const dataDir = mkDataDir('streak3')
  const probes = healthyProbes()
  probes['qq-ws'] = async () => ({ ok: false, detail: '桥接 sidecar 已 20 分钟未更新' })
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  const r1 = await ledger.check()
  assert.equal(r1.ok, true)
  assert.equal(r1.critical, 0)
  assert.deepEqual(
    { status: itemOf(r1, 'qq-ws').status, streak: itemOf(r1, 'qq-ws').failureStreak },
    { status: 'warn', streak: 1 },
  )

  const r2 = await ledger.check()
  assert.equal(r2.critical, 0)
  assert.deepEqual(
    { status: itemOf(r2, 'qq-ws').status, streak: itemOf(r2, 'qq-ws').failureStreak },
    { status: 'warn', streak: 2 },
  )

  const r3 = await ledger.check()
  assert.equal(r3.critical, 1)
  assert.deepEqual(
    { status: itemOf(r3, 'qq-ws').status, streak: itemOf(r3, 'qq-ws').failureStreak },
    { status: 'critical', streak: 3 },
  )
  // 其它项全程 ok，没被连坐
  assert.equal(itemOf(r3, 'napcat-port').status, 'ok')
  assert.equal(itemOf(r3, 'napcat-port').failureStreak, 0)
})

test('中途成功一次 → 计数归零，再失败要重新数到 3', async () => {
  const dataDir = mkDataDir('reset')
  let healthy = false
  const probes = healthyProbes()
  probes['effect-queue'] = async () =>
    healthy ? { ok: true, detail: '队列清爽' } : { ok: false, detail: '7 条积压超 60s' }
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  await ledger.check()
  const r2 = await ledger.check()
  assert.equal(itemOf(r2, 'effect-queue').failureStreak, 2)

  healthy = true
  const r3 = await ledger.check()
  assert.deepEqual(
    { status: itemOf(r3, 'effect-queue').status, streak: itemOf(r3, 'effect-queue').failureStreak },
    { status: 'ok', streak: 0 },
  )

  healthy = false
  const r4 = await ledger.check()
  assert.deepEqual(
    { status: itemOf(r4, 'effect-queue').status, streak: itemOf(r4, 'effect-queue').failureStreak },
    { status: 'warn', streak: 1 },
  )
  assert.equal(r4.critical, 0)

  // 再来两次才重新升到 critical
  await ledger.check()
  const r6 = await ledger.check()
  assert.equal(itemOf(r6, 'effect-queue').failureStreak, 3)
  assert.equal(r6.critical, 1)
})

test('ok:null 连来 5 次：status=unknown、critical=0、计数不计入（未被误判成故障）', async () => {
  const dataDir = mkDataDir('unknown')
  const probes = healthyProbes()
  probes['heartbeat-seed'] = async () => ({ ok: null, detail: '加密账本不存在，测不出来' })
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  for (let i = 1; i <= 5; i += 1) {
    const r = await ledger.check()
    const item = itemOf(r, 'heartbeat-seed')
    assert.equal(item.status, 'unknown', `第 ${i} 次应仍是 unknown`)
    assert.equal(item.failureStreak, 0, `第 ${i} 次计数必须为 0`)
    assert.equal(r.critical, 0, `第 ${i} 次不应有任何 critical`)
  }

  // unknown 还会把已经攒起来的失败计数清零：失败 2 次 → unknown → 再失败只能是 1
  const probes2 = healthyProbes()
  let mode = 'fail'
  probes2['zone-orphan'] = async () =>
    mode === 'fail' ? { ok: false, detail: '1 个孤儿' } : { ok: null, detail: '读不到日程' }
  const ledger2 = createHealthLedger({ dataDir: mkDataDir('unknown-clears'), probes: probes2, nowMs: () => NOW })
  await ledger2.check()
  const two = await ledger2.check()
  assert.equal(itemOf(two, 'zone-orphan').failureStreak, 2)
  mode = 'unknown'
  const cleared = await ledger2.check()
  assert.equal(itemOf(cleared, 'zone-orphan').status, 'unknown')
  assert.equal(itemOf(cleared, 'zone-orphan').failureStreak, 0)
  mode = 'fail'
  const again = await ledger2.check()
  assert.deepEqual(
    { status: itemOf(again, 'zone-orphan').status, streak: itemOf(again, 'zone-orphan').failureStreak },
    { status: 'warn', streak: 1 },
  )
})

test('探针抛异常 → 收成 unknown，整次 check 不挂、也不 reject', async () => {
  const dataDir = mkDataDir('throws')
  const probes = healthyProbes()
  probes['dsh-port'] = async () => {
    throw new Error('boom: 日志目录不可读')
  }
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  const r = await ledger.check() // 不 throw 就是通过
  assert.equal(r.ok, true)
  assert.equal(r.critical, 0)
  const item = itemOf(r, 'dsh-port')
  assert.equal(item.status, 'unknown')
  assert.equal(item.failureStreak, 0)
  assert.match(item.detail, /boom/)
  assert.equal(r.items.length, MONITOR_NAMES.length)
  // 抛异常也不该让别项变味
  assert.equal(itemOf(r, 'qq-ws').status, 'ok')
})

test('探针返回垃圾值（非对象 / 缺 ok）也归 unknown，不污染状态', async () => {
  const dataDir = mkDataDir('garbage')
  const probes = healthyProbes()
  probes['schedule-last'] = async () => undefined
  probes['qq-ws'] = async () => ({ detail: '没给 ok' })
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  const r = await ledger.check()
  assert.equal(itemOf(r, 'schedule-last').status, 'unknown')
  assert.equal(itemOf(r, 'qq-ws').status, 'unknown')
  assert.equal(r.critical, 0)
})

test('report.md 含表头与「连续失败」字样，且内容与该次结果一致', async () => {
  const dataDir = mkDataDir('report')
  const probes = healthyProbes()
  probes['qq-ws'] = async () => ({ ok: false, detail: 'ws 断了 | 带竖线的详情' })
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  await ledger.check()
  await ledger.check()
  const r3 = await ledger.check()

  const md = fs.readFileSync(ledger.paths.reportPath, 'utf8')
  assert.match(md, /^# 系统健康 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/m, '首行是标题带时间')
  assert.ok(md.includes('| 项 | 状态 | 连续失败 | 详情 |'), '表头必须一字不差')
  assert.ok(md.includes('连续失败'))
  assert.ok(md.includes('| qq-ws | critical | 3 |'), '升级行要写进表里')
  assert.ok(md.includes('\\|'), '详情里的竖线要被转义，否则表格会断列')
  assert.equal(r3.items.length, MONITOR_NAMES.length)

  // 纯函数也能直接渲染（index.js 想单独出一份报告时用得上）
  const md2 = buildReportMarkdown(NOW, [{ name: 'x', status: 'warn', failureStreak: 1, detail: 'd' }])
  assert.ok(md2.includes('| x | warn | 1 | d |'))
})

test('health.jsonl 每次 check 追加一行，首行是一条说明记录', async () => {
  const dataDir = mkDataDir('jsonl')
  const ledger = createHealthLedger({ dataDir, probes: healthyProbes(), nowMs: () => NOW })

  await ledger.check()
  await ledger.check()

  const lines = fs
    .readFileSync(ledger.paths.healthFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  assert.equal(lines.length, 3, '说明行 + 两次 check 各一行')
  const marker = JSON.parse(lines[0])
  assert.ok(marker._ && /不是给模型读的状态文件/.test(marker._))
  const row = JSON.parse(lines[2])
  assert.equal(row.items.length, MONITOR_NAMES.length)
  assert.equal(row.critical, 0)
  assert.ok(typeof row.ts === 'string' && row.ts.includes('2026-11-04'))
})

test('一个探针挂掉不影响其他探针的结果', async () => {
  const dataDir = mkDataDir('isolation')
  const probes = healthyProbes()
  probes['napcat-port'] = async () => {
    throw new Error('ECONNREFUSED')
  }
  probes['effect-queue'] = async () => ({ ok: false, detail: '6 条积压' })
  probes['heartbeat-seed'] = async () => ({ ok: null, detail: '没有账本' })
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  const r = await ledger.check()
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i.status]))
  assert.deepEqual(byName, {
    'qq-ws': 'ok',
    'napcat-port': 'unknown',
    'dsh-port': 'ok',
    'effect-queue': 'warn',
    'schedule-last': 'ok',
    'heartbeat-seed': 'unknown',
    'zone-orphan': 'ok',
  })
  assert.equal(r.critical, 0)
})

test('未注入的探针 → unknown；额外注入的探针也会被记录', async () => {
  const dataDir = mkDataDir('missing')
  const probes = { 'qq-ws': async () => ({ ok: true, detail: 'ok' }), 'extra-thing': async () => ({ ok: true, detail: '额外项' }) }
  const ledger = createHealthLedger({ dataDir, probes, nowMs: () => NOW })

  const r = await ledger.check()
  assert.equal(r.items.length, MONITOR_NAMES.length + 1)
  assert.equal(itemOf(r, 'napcat-port').status, 'unknown')
  assert.match(itemOf(r, 'napcat-port').detail, /未注入/)
  assert.equal(itemOf(r, 'extra-thing').status, 'ok')
})

test('同一 dataDir 重建账本（模拟进程重启）→ 计数从 health.jsonl 回放，不归零', async () => {
  const dataDir = mkDataDir('restart')
  const probes = healthyProbes()
  probes['dsh-port'] = async () => ({ ok: false, detail: '发现不到端口' })

  const first = createHealthLedger({ dataDir, probes, nowMs: () => NOW })
  await first.check()
  const before = await first.check()
  assert.equal(itemOf(before, 'dsh-port').failureStreak, 2)

  // 新实例 = 插件重启后重新 new 的那一个；计数应接着 2 往上数
  const second = createHealthLedger({ dataDir, probes, nowMs: () => NOW })
  const afterRestart = await second.check()
  assert.deepEqual(
    { status: itemOf(afterRestart, 'dsh-port').status, streak: itemOf(afterRestart, 'dsh-port').failureStreak },
    { status: 'critical', streak: 3 },
  )
  assert.equal(afterRestart.critical, 1)
})

test('createRealProbes 只算路径不碰盘：返回七项，且创建时不读真实状态文件', () => {
  const probes = createRealProbes({})
  for (const name of MONITOR_NAMES) assert.equal(typeof probes[name], 'function', `${name} 应存在`)
  assert.equal(Object.keys(probes).length, MONITOR_NAMES.length)
  // 阈值常量对得上 §6.2
  assert.equal(CRITICAL_THRESHOLD, 3)
})
