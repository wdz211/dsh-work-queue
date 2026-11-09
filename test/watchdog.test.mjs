/**
 * test/watchdog.test.mjs —— P2b 看门狗（只读扫描）的覆盖。
 *
 * 全部落盘都走 `fs.mkdtempSync(os.tmpdir())`，**绝不碰** `~/.dsh-beta/workqueue`。
 * 所有时间都是注入的固定时钟 `BASE`：`idleMs` / `waitingMs` 这类判定要精确验，
 * 不能靠真等两小时。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { createStore } from '../src/store.mjs'
import {
  IDLE_MS_DEFAULT,
  WAITING_MS_DEFAULT,
  WATCHDOG_ITEM_KEYS,
  WATCHDOG_SECTIONS,
  classifyItem,
  createWatchdog,
  fingerprintTickets,
} from '../lib/watchdog.mjs'

/** 固定的「现在」。 */
const BASE = Date.parse('2026-11-04T12:00:00.000Z')
const MIN = 60_000
const HOUR = 3600_000

/** 建过的临时目录，收尾统一清掉（测试自己产生的垃圾自己带走）。 */
const tmpDirs = []
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清不掉就算了，反正不在用户家里 */
    }
  }
})

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wq-watchdog-'))
  tmpDirs.push(dir)
  return dir
}

/** 递归快照：相对路径 → { sha256, size }。用来证明「一字节没变」。 */
function snapshotDir(root) {
  const out = {}
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const rel = path.relative(root, full).split(path.sep).join('/')
      const buf = fs.readFileSync(full)
      out[rel] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length }
    }
  }
  walk(root)
  return out
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 只读门面：读方法转发并记账，写方法一被调用就抛（并记成 `WRITE:xxx`）。
 * 这是「scan 绝不调写方法」的直接证据——不是靠读代码相信，而是靠一调就炸。
 */
const READ_METHODS = ['listTickets', 'readIndex', 'readEvents', 'getTicket', 'readTicket']
const WRITE_METHODS = [
  'openTicket',
  'reportTicket',
  'closeTicket',
  'attachTicket',
  'appendEvent',
  'rebuildIndex',
  'ensureDirs',
  'newId',
  'runExclusive',
]

function trackedStore(store) {
  const calls = []
  const facade = {
    dataDir: store.dataDir,
    ticketsDir: store.ticketsDir,
    workRoot: store.workRoot,
    eventsPath: store.eventsPath,
  }
  for (const name of READ_METHODS) {
    facade[name] = async (...args) => {
      calls.push(name)
      return store[name](...args)
    }
  }
  for (const name of WRITE_METHODS) {
    facade[name] = async () => {
      calls.push(`WRITE:${name}`)
      throw new Error(`看门狗不该调用写方法：${name}`)
    }
  }
  return { facade, calls }
}

/**
 * 造一整套工单场景（时间全部由可变时钟精确摆放）：
 *
 *   ① 搁置 3h、p0、有 owner      → stalled[0]
 *   ② 搁置 5h、p1、**没有 owner** → stalled[1]（顺便验空 owner 落 ''）
 *   ③ 搁置正好 2h、p2（边界）     → stalled[2]（stage.mjs 用 >=，边界算 idle）
 *   ④ 连报 3 次 failed            → stuck
 *   ⑤ 等我回话已 25h              → waiting（> 24h 阈值）
 *   ⑥ 等我审阅只 1h               → 不进任何清单
 *   ⑦ 已关闭的单                  → 永不出现
 *   ⑧ 5 分钟前刚报 progress        → 不进任何清单
 */
async function seed(dataDir) {
  const clock = { now: BASE }
  const store = createStore({ dataDir, nowMs: () => clock.now })
  const ids = {}

  clock.now = BASE - 3 * HOUR
  ids.idle = (await store.openTicket({
    title: '搁置的单',
    priority: 'p0',
    owner: { role: 'lead', sessionId: 'sess-idle-0001' },
  })).ticket.id

  clock.now = BASE - 5 * HOUR
  ids.idleNoOwner = (await store.openTicket({ title: '没人认领的搁置单' })).ticket.id

  clock.now = BASE - 2 * HOUR
  ids.idleBoundary = (await store.openTicket({ title: '正好卡在 2 小时边界', priority: 'p2' })).ticket.id

  clock.now = BASE - 4 * HOUR
  ids.stuck = (await store.openTicket({
    title: '卡死的单',
    priority: 'p1',
    owner: { role: 'worker', sessionId: 'sess-stuck-0002' },
  })).ticket.id
  clock.now = BASE - 3 * HOUR
  await store.reportTicket(ids.stuck, { outcome: 'failed', note: '第一次' })
  clock.now = BASE - 2 * HOUR
  await store.reportTicket(ids.stuck, { outcome: 'failed', note: '第二次' })
  clock.now = BASE - 30 * MIN
  await store.reportTicket(ids.stuck, { outcome: 'failed', note: '第三次' })

  clock.now = BASE - 26 * HOUR
  ids.waitingOver = (await store.openTicket({
    title: '等回话超时',
    owner: { role: 'lead', sessionId: 'sess-wait-0003' },
  })).ticket.id
  clock.now = BASE - 25 * HOUR
  await store.reportTicket(ids.waitingOver, { outcome: 'waiting-answer', note: '要人拍板' })

  clock.now = BASE - 2 * HOUR
  ids.waitingFresh = (await store.openTicket({
    title: '刚等我审阅',
    owner: { role: 'lead', sessionId: 'sess-wait-0004' },
  })).ticket.id
  clock.now = BASE - 1 * HOUR
  await store.reportTicket(ids.waitingFresh, { outcome: 'waiting-review', evidence: 'diff 在 work/ 下' })

  clock.now = BASE - 6 * HOUR
  ids.closed = (await store.openTicket({ title: '已经关掉的单' })).ticket.id
  clock.now = BASE - 5 * HOUR
  await store.reportTicket(ids.closed, { outcome: 'failed' })
  clock.now = BASE - 4 * HOUR
  await store.closeTicket(ids.closed, { conclusion: '测试用，关掉' })

  clock.now = BASE - 10 * MIN
  ids.working = (await store.openTicket({ title: '正在推进' })).ticket.id
  clock.now = BASE - 5 * MIN
  await store.reportTicket(ids.working, { outcome: 'progress', note: '在跑测试' })

  clock.now = BASE
  return { store, clock, ids }
}

function idsOf(list) {
  return list.map((item) => item.id)
}

// ── 导出契约 ─────────────────────────────────────────────────────────────

test('导出契约：三个清单名 + 两个默认阈值', () => {
  assert.deepEqual([...WATCHDOG_SECTIONS], ['stalled', 'stuck', 'waiting'])
  assert.ok(Object.isFrozen(WATCHDOG_SECTIONS))
  assert.equal(IDLE_MS_DEFAULT, 7200000)
  assert.equal(WAITING_MS_DEFAULT, 86400000)
  assert.deepEqual([...WATCHDOG_ITEM_KEYS], [
    'id', 'title', 'stage', 'stageLabel', 'priority',
    'ownerRole', 'ownerSessionId', 'updatedAt', 'idleForMs', 'lastOutcome',
  ])
})

// ── 分类（主场景）────────────────────────────────────────────────────────

test('三种分类各自归类正确，且不该进的单一张都不进', async () => {
  const { store, ids } = await seed(tmpDir())
  const watchdog = createWatchdog({ store, nowMs: BASE })
  const result = await watchdog.scan()

  assert.equal(result.ok, true)
  assert.equal(result.ts, new Date(BASE).toISOString())

  // 返回键必须是契约里那七个，多一个都会让严格的 output schema 拒收整份结果
  assert.deepEqual(
    Object.keys(result).sort(),
    ['counts', 'ok', 'stalled', 'stuck', 'ts', 'unchanged', 'waiting'],
  )

  // 排序按 compareTickets：stage → priority → updatedAt 新在前 → id
  assert.deepEqual(idsOf(result.stalled), [ids.idle, ids.idleNoOwner, ids.idleBoundary])
  assert.deepEqual(idsOf(result.stuck), [ids.stuck])
  assert.deepEqual(idsOf(result.waiting), [ids.waitingOver])

  assert.deepEqual(result.counts, { stalled: 3, stuck: 1, waiting: 1 })

  // 不该出现的：刚等 1h 的、已关闭的、刚报过 progress 的
  const seen = [...idsOf(result.stalled), ...idsOf(result.stuck), ...idsOf(result.waiting)]
  for (const absent of [ids.waitingFresh, ids.closed, ids.working]) {
    assert.equal(seen.includes(absent), false, `不该出现在清单里：${absent}`)
  }
})

test('item 各字段取值正确（含 stage / stageLabel / idleForMs / lastOutcome）', async () => {
  const { store, ids } = await seed(tmpDir())
  const result = await createWatchdog({ store, nowMs: BASE }).scan()

  const idle = result.stalled[0]
  assert.equal(idle.id, ids.idle)
  assert.equal(idle.title, '搁置的单')
  assert.equal(idle.stage, 'idle')
  assert.equal(idle.stageLabel, '搁置（超 2 小时没动）')
  assert.equal(idle.priority, 'p0')
  assert.equal(idle.ownerRole, 'lead')
  assert.equal(idle.ownerSessionId, 'sess-idle-0001')
  assert.equal(idle.updatedAt, new Date(BASE - 3 * HOUR).toISOString())
  assert.equal(idle.idleForMs, 3 * HOUR)
  assert.equal(idle.lastOutcome, '') // 从没报过 → 投影是 null，这里必须是 ''

  const stuck = result.stuck[0]
  assert.equal(stuck.stage, 'stuck')
  assert.equal(stuck.stageLabel, '卡死（连续失败 3 次）')
  assert.equal(stuck.lastOutcome, 'failed')
  assert.equal(stuck.idleForMs, 30 * MIN)

  const waiting = result.waiting[0]
  assert.equal(waiting.stage, 'waiting-answer')
  assert.equal(waiting.stageLabel, '等我回话')
  assert.equal(waiting.idleForMs, 25 * HOUR)

  // 边界：正好 2 小时算 idle（与 stage.mjs 的 >= 一致）
  const boundary = result.stalled[2]
  assert.equal(boundary.id, ids.idleBoundary)
  assert.equal(boundary.idleForMs, 2 * HOUR)
})

test('没 owner 的单：ownerRole / ownerSessionId 都是空字符串', async () => {
  const { store, ids } = await seed(tmpDir())
  const result = await createWatchdog({ store, nowMs: BASE }).scan()
  const item = result.stalled.find((entry) => entry.id === ids.idleNoOwner)
  assert.ok(item, '没人认领的搁置单应当出现在 stalled 里')
  assert.equal(item.ownerRole, '')
  assert.equal(item.ownerSessionId, '')
  assert.equal(item.priority, 'p1')
})

test('waiting 未超时不进清单；waitingMs 可被单次调用覆盖', async () => {
  const { store, ids } = await seed(tmpDir())
  const watchdog = createWatchdog({ store, nowMs: BASE })

  const strict = await watchdog.scan({ waitingMs: 30 * HOUR })
  assert.deepEqual(idsOf(strict.waiting), [], '25h 不到 30h，不该进 waiting')

  const loose = await watchdog.scan({ waitingMs: 60 * MIN })
  assert.deepEqual(idsOf(loose.waiting), [ids.waitingOver, ids.waitingFresh], '1h 也够 60 分钟')

  // waiting 严格按 waiting-answer/waiting-review 走：progress/failed 不会被算进去
  const sections = [...idsOf(loose.stalled), ...idsOf(loose.stuck), ...idsOf(loose.waiting)]
  assert.equal(sections.includes(ids.working), false)
  assert.equal(sections.includes(ids.closed), false)
})

test('纯函数 classifyItem 的边界（closed / 空 stage / 未知 stage 都不进清单）', () => {
  assert.equal(classifyItem({ stage: 'closed', idleForMs: 999 * HOUR }), '')
  assert.equal(classifyItem({ stage: '', idleForMs: 999 * HOUR }), '')
  assert.equal(classifyItem({ stage: 'queued', idleForMs: 999 * HOUR }), '')
  assert.equal(classifyItem({ stage: 'blocked', idleForMs: 999 * HOUR }), '')
  assert.equal(classifyItem({ stage: 'idle', idleForMs: 0 }), 'stalled')
  assert.equal(classifyItem({ stage: 'stuck', idleForMs: 0 }), 'stuck')
  assert.equal(classifyItem({ stage: 'waiting-answer', idleForMs: WAITING_MS_DEFAULT }), 'waiting')
  assert.equal(classifyItem({ stage: 'waiting-answer', idleForMs: WAITING_MS_DEFAULT - 1 }), '')
  assert.equal(classifyItem(null), '')
})

// ── 空库 ────────────────────────────────────────────────────────────────

test('空库：三个空数组、counts 全 0、unchanged 为 true', async () => {
  const store = createStore({ dataDir: tmpDir(), nowMs: () => BASE })
  const result = await createWatchdog({ store, nowMs: BASE }).scan()

  assert.equal(result.ok, true)
  assert.deepEqual(result.stalled, [])
  assert.deepEqual(result.stuck, [])
  assert.deepEqual(result.waiting, [])
  assert.deepEqual(result.counts, { stalled: 0, stuck: 0, waiting: 0 })
  assert.equal(result.unchanged, true)
})

// ── 只读性（核心验收）────────────────────────────────────────────────────

test('只读性：scan 前后工单文件 sha256 完全一致、且一个新文件都没产生', async () => {
  const dir = tmpDir()
  const { store } = await seed(dir)

  const before = snapshotDir(dir)
  assert.ok(Object.keys(before).some((rel) => rel.startsWith('tickets/')), '前置：工单文件必须存在')

  const result = await createWatchdog({ store, nowMs: BASE }).scan()

  const after = snapshotDir(dir)
  assert.equal(result.ok, true)
  assert.equal(result.unchanged, true)

  // 逐文件 sha256 逐个比对（deepEqual 会打印出到底哪个文件动了）
  assert.deepEqual(after, before)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  for (const rel of Object.keys(before)) {
    assert.equal(after[rel].sha256, before[rel].sha256, `文件被改动了：${rel}`)
  }

  // scan 走的是 listTickets + readEvents（零写入），所以索引缓存根本不会被建出来
  assert.equal(fs.existsSync(path.join(dir, 'index.json')), false, 'scan 不该触发索引重建/落盘')
  assert.equal(fs.existsSync(path.join(dir, 'index.json.tmp')), false, 'scan 不该留下 tmp 残片')
})

test('只读性：scan 一次都没碰 store 的写方法（一调就炸的门面）', async () => {
  const { store } = await seed(tmpDir())
  const { facade, calls } = trackedStore(store)
  const result = await createWatchdog({ store: facade, nowMs: BASE }).scan()

  assert.equal(result.ok, true)
  assert.deepEqual(calls.filter((call) => call.startsWith('WRITE:')), [], '看门狗调用了写方法')
  assert.ok(calls.includes('listTickets'), '应当通过 listTickets 读工单')
  assert.ok(calls.includes('readEvents'), '应当一次读出事件流用于派生 stage')
  assert.equal(calls.includes('readIndex'), false, '主路径不该走 readIndex（它会写索引缓存）')
})

test('指纹函数：内容变则指纹变，空目录归一为 ""', async () => {
  const dir = tmpDir()
  const ticketsDir = path.join(dir, 'tickets')
  fs.mkdirSync(ticketsDir, { recursive: true })
  assert.equal(fingerprintTickets(ticketsDir), '')

  const file = path.join(ticketsDir, 't-1.json')
  fs.writeFileSync(file, '{"id":"t-1"}\n', 'utf8')
  const first = fingerprintTickets(ticketsDir)
  assert.equal(first.length, 16)
  assert.equal(fingerprintTickets(ticketsDir), first, '内容没变 → 指纹必须一样')

  fs.writeFileSync(file, '{"id":"t-1","x":1}\n', 'utf8')
  assert.notEqual(fingerprintTickets(ticketsDir), first, '内容变了 → 指纹必须变')

  assert.equal(fingerprintTickets(''), '')
  assert.equal(fingerprintTickets(path.join(dir, '不存在')), '')
})

// ── report 纯函数 ───────────────────────────────────────────────────────

test('report 是纯函数：同输入同输出、不改入参、不产生文件', async () => {
  const dir = tmpDir()
  const { store } = await seed(dir)
  const watchdog = createWatchdog({ store, nowMs: BASE })
  const result = await watchdog.scan()

  const before = snapshotDir(dir)
  const text1 = watchdog.report(result)
  const text2 = watchdog.report(result)
  const after = snapshotDir(dir)

  assert.equal(typeof text1, 'string')
  assert.ok(text1.length > 0)
  assert.equal(text1, text2, '同输入必须同输出')
  assert.equal(watchdog.report(JSON.parse(JSON.stringify(result))), text1, '等价输入必须同输出')
  assert.deepEqual(after, before, 'report 不该产生/改动任何文件')

  // 时间戳只能来自入参，不能来自真实时钟
  assert.ok(text1.includes(result.ts), '渲染的时间戳必须取自 result.ts')

  // deepFreeze 后还能跑通 = 它没改入参
  deepFreeze(result)
  assert.equal(watchdog.report(result), text1)
})

test('report 对空清单 / 坏输入 / ok:false 都能渲染且不抛', () => {
  const watchdog = createWatchdog({ nowMs: BASE })

  const empty = {
    ok: true,
    ts: new Date(BASE).toISOString(),
    stalled: [],
    stuck: [],
    waiting: [],
    counts: { stalled: 0, stuck: 0, waiting: 0 },
    unchanged: true,
  }
  const emptyText = watchdog.report(empty)
  assert.ok(emptyText.includes('无停滞'))
  assert.ok(emptyText.includes('unchanged') || emptyText.includes('只读校验'))

  assert.equal(typeof watchdog.report(null), 'string')
  assert.equal(typeof watchdog.report('字符串'), 'string')

  const failed = watchdog.report({ ok: false, code: 'STORE_UNAVAILABLE', message: '读不到工单' })
  assert.ok(failed.includes('STORE_UNAVAILABLE'))
  assert.ok(failed.includes('读不到工单'))
})

test('report 的清单渲染包含 id/标题/停多久（表格形态）', async () => {
  const { store, ids } = await seed(tmpDir())
  const watchdog = createWatchdog({ store, nowMs: BASE })
  const text = watchdog.report(await watchdog.scan())

  assert.ok(text.includes(ids.idle), '应当列出搁置单的 id')
  assert.ok(text.includes('搁置的单'), '应当列出标题')
  assert.ok(text.includes('3 小时'), '应当给出停多久')
  assert.ok(text.includes('卡死的单'))
  assert.ok(text.includes('等回话超时'))
})

// ── null 自由（output schema 硬要求）────────────────────────────────────

test('item 字段无 null：十个字段全是 string/number，且序列化后不含 null', async () => {
  const { store } = await seed(tmpDir())
  const result = await createWatchdog({ store, nowMs: BASE }).scan()
  const all = [...result.stalled, ...result.stuck, ...result.waiting]
  assert.ok(all.length >= 5, '前置：应当有若干条待检 item')

  for (const item of all) {
    assert.deepEqual(Object.keys(item).sort(), [...WATCHDOG_ITEM_KEYS].sort(), `字段集合不对：${item.id}`)
    for (const key of WATCHDOG_ITEM_KEYS) {
      assert.notEqual(item[key], null, `字段 ${key} 是 null（id=${item.id}）`)
      assert.notEqual(item[key], undefined, `字段 ${key} 是 undefined（id=${item.id}）`)
      assert.ok(
        typeof item[key] === 'string' || typeof item[key] === 'number',
        `字段 ${key} 类型不对：${typeof item[key]}`,
      )
    }
    const json = JSON.stringify(item)
    assert.equal(json.includes('null'), false, `序列化后仍含 null：${json}`)
  }
})

// ── 时钟与降级 ──────────────────────────────────────────────────────────

test('nowMs 可以是函数（与 store 参数风格一致）', async () => {
  const { store } = await seed(tmpDir())
  const asNumber = await createWatchdog({ store, nowMs: BASE }).scan()
  const asFunction = await createWatchdog({ store, nowMs: () => BASE }).scan()
  assert.deepEqual(asFunction, asNumber)
})

test('没注入时钟：不偷读真实时间，idleForMs 一律 0、ts 为 ""', async () => {
  const { store } = await seed(tmpDir())
  const result = await createWatchdog({ store }).scan()

  assert.equal(result.ok, true)
  assert.equal(result.ts, '')
  const all = [...result.stalled, ...result.stuck, ...result.waiting]
  for (const item of all) assert.equal(item.idleForMs, 0)
  // 认不出时间就不判搁置（宁可不给这一档，也不拿真时间去猜）
  assert.deepEqual(idsOf(result.stalled), [])
})

test('store 不可用时给 ok:false，绝不假装「无停滞」', async () => {
  const broken = createStore({ dataDir: '' }) // store 自己的坏输入壳
  const result = await createWatchdog({ store: broken, nowMs: BASE }).scan()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'STORE_UNAVAILABLE')
  assert.equal(typeof result.message, 'string')

  const noStore = await createWatchdog({ nowMs: BASE }).scan()
  assert.equal(noStore.ok, false)
  assert.equal(noStore.code, 'STORE_UNAVAILABLE')

  const noArgs = await createWatchdog().scan()
  assert.equal(noArgs.ok, false)
  assert.equal(noArgs.code, 'STORE_UNAVAILABLE')
})

test('坏 nowMs / 坏阈值参数都不炸，回落到默认', async () => {
  const { store, ids } = await seed(tmpDir())
  const watchdog = createWatchdog({ store, nowMs: BASE, idleMs: -5, waitingMs: 'abc' })
  const result = await watchdog.scan({ idleMs: NaN, waitingMs: 0 })

  assert.equal(result.ok, true)
  // waitingMs 给了 0（不是正数）→ 回落 24h 默认，25h 的单照样进 waiting
  assert.deepEqual(idsOf(result.waiting), [ids.waitingOver])
  assert.equal(result.stalled.length, 3)
})

test('createWatchdog 收垃圾参数也不 throw', async () => {
  for (const bad of [null, undefined, 0, 'x', { store: null }, { store: 'not-a-store' }]) {
    const watchdog = createWatchdog(bad)
    assert.equal(typeof watchdog.scan, 'function')
    assert.equal(typeof watchdog.report, 'function')
    const result = await watchdog.scan()
    assert.equal(result.ok, false)
    assert.equal(typeof watchdog.report(result), 'string')
  }
})

// ── 验收形态（spec §5 ①）────────────────────────────────────────────────

test('验收①形态：造一张 2 小时无变化的单，用注入 nowMs 扫出来且文件字节不变', async () => {
  const dir = tmpDir()
  const clock = { now: BASE - 2 * HOUR }
  const store = createStore({ dataDir: dir, nowMs: () => clock.now })
  const id = (await store.openTicket({ title: '两小时没人管的单', priority: 'p1' })).ticket.id

  clock.now = BASE // 「现在」往前拨 2 小时，单子一动不动
  const before = snapshotDir(dir)

  const result = await createWatchdog({ store, nowMs: BASE }).scan()

  const after = snapshotDir(dir)
  assert.deepEqual(idsOf(result.stalled), [id])
  assert.equal(result.stalled[0].idleForMs, 2 * HOUR)
  assert.equal(result.unchanged, true)
  assert.deepEqual(after, before, '跑完后工单文件必须一字节不变')

  // 前后 sha256 明写出来，方便人工复核
  const rel = `tickets/${id}.json`
  assert.equal(after[rel].sha256, before[rel].sha256)
})
