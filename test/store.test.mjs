/**
 * test/store.test.mjs —— 落盘层的四件硬事：原子写、同单串行、索引重建、坏文件隔离。
 *
 * ⚠️ 所有用例都在 `os.tmpdir()` 下开独立目录，`after()` 统一清理。
 * **绝不**碰 `~/.dsh-beta/workqueue`——测试往生产数据目录写一次，就会污染真实工单，
 * 而且事后没人分得清哪些是测试造的。
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { EVENTS_HEADER, createStore } from '../src/store.mjs'

/** 本次跑测建出来的所有临时根目录，after() 一把清掉。 */
const tempRoots = []

/** 开一个隔离的 store（每次一个新目录）。 */
function tmpStore(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wq-store-'))
  tempRoots.push(dataDir)
  const store = createStore({ dataDir, ...opts })
  return { store, dataDir }
}

after(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
})

/** 读一个 JSON 文件（测试专用）。 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ── 0. 不 throw 的底线 ───────────────────────────────────────────────────

test('createStore 没给 dataDir 时不 throw，而是返回一个处处如实报错的空壳', async () => {
  const broken = createStore({})
  assert.equal(broken.ok, false)
  assert.equal(broken.code, 'NO_DATA_DIR')
  const result = await broken.openTicket({ title: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_DATA_DIR')
  // 每个方法都得能用且都返回失败（不许 throw）
  for (const method of ['listTickets', 'readIndex', 'rebuildIndex', 'ensureDirs']) {
    const r = await broken[method]()
    assert.equal(r.ok, false, `${method} 在空壳上应当返回 ok:false`)
  }
})

test('dataDir 里没有 tickets 目录时也能读（返回空列表，不报错）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wq-empty-'))
  tempRoots.push(dataDir)
  const store = createStore({ dataDir })
  const listed = await store.listTickets()
  assert.equal(listed.ok, true)
  assert.deepEqual(listed.tickets, [])
  assert.deepEqual(listed.corrupt, [])
})

// ── 1. 开单落盘 ──────────────────────────────────────────────────────────

test('openTicket 写出 ticket 文件 + open 事件 + work/<short> 目录，不留 tmp 残留', async () => {
  const { store, dataDir } = tmpStore()
  const created = await store.openTicket({
    title: '把 QQ 图片失败重投接进队列',
    kind: 'qq',
    priority: 'p0',
    owner: { role: 'lead', sessionId: 'session-a' },
    cwd: 'D:/some/where',
  })

  assert.equal(created.ok, true)
  const id = created.ticket.id
  assert.match(id, /^t-[0-9a-z]{8}$/, 'id 必须是 t- + 8 位 base36')

  const ticketFile = path.join(dataDir, 'tickets', `${id}.json`)
  assert.ok(fs.existsSync(ticketFile), 'ticket 文件必须落盘')
  const onDisk = readJson(ticketFile)
  assert.equal(onDisk.id, id)
  assert.equal(onDisk.title, '把 QQ 图片失败重投接进队列')
  assert.equal(onDisk.priority, 'p0')
  assert.equal(onDisk.kind, 'qq')
  assert.equal(onDisk.reports, 0)
  assert.equal(onDisk.failStreak, 0)
  // 三个「还没发生」的字段一律是 '' 而不是 null。
  // 原因：DSH 工具的 output schema 是 additionalProperties:false 且类型严格，
  // 一个 null 撞上 type:'string' 会让「整个工具结果」被校验层拒收——P1 实测翻过车：
  // 一张 closedAt 为 null 的空单让 work_list 全量报 invalid output。
  // 读端兜底只能治标，所以写入端就不产出 null。
  assert.equal(onDisk.closedAt, '')
  assert.equal(onDisk.closedReason, '')
  assert.equal(onDisk.lastReport, '')

  // 一单一目录（spec §0 的 P1c）
  assert.equal(created.dir, path.join(dataDir, 'work', id.slice(2)))
  assert.ok(fs.statSync(created.dir).isDirectory(), 'work/<short> 必须是真目录')
  assert.ok(path.isAbsolute(created.dir), '返回的 dir 必须是绝对路径')

  // 事件
  const evs = await store.readEvents(id)
  assert.equal(evs.ok, true)
  assert.equal(evs.events.length, 1)
  assert.equal(evs.events[0].type, 'open')
  assert.equal(evs.events[0].ticketId, id)

  // 原子写不留 tmp
  const names = fs.readdirSync(path.join(dataDir, 'tickets'))
  assert.deepEqual(names.filter((n) => n.includes('.tmp')), [])
})

test('events.jsonl 第一行是说明行（spec §1.8），读的时候必须跳过它', async () => {
  const { store, dataDir } = tmpStore()
  const created = await store.openTicket({ title: '说明行' })
  const raw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
  assert.ok(raw.startsWith(EVENTS_HEADER), '第一行必须是那条 _ 说明记录')
  // 读出来不能把它当成事件
  const evs = await store.readEvents(created.ticket.id)
  assert.ok(evs.events.every((e) => e.type !== undefined && e._ === undefined))
})

// ── 2. 原子写：半截文件永远读不到 ────────────────────────────────────────

test('★ 模拟「写到一半就被杀」：残留的 <id>.json.tmp 不会被当成工单，旧内容照常可读', async () => {
  const { store, dataDir } = tmpStore()
  const created = await store.openTicket({ title: '旧内容' })
  const id = created.ticket.id

  // 手造一个"崩溃在 rename 之前"留下的半截 tmp（这正是不用 tmp+rename 时正式文件会长的样子）
  const half = '{"id":"' + id + '","title":"写到一半就断电'
  fs.writeFileSync(path.join(dataDir, 'tickets', `${id}.json.tmp`), half, 'utf8')

  const listed = await store.listTickets()
  assert.equal(listed.ok, true)
  assert.equal(listed.tickets.length, 1, 'tmp 不算工单')
  assert.deepEqual(listed.corrupt, [], 'tmp 也不该被记成损坏文件')

  const read = await store.readTicket(id)
  assert.equal(read.ok, true)
  assert.equal(read.ticket.title, '旧内容', '读者必须看到完整的旧内容')
})

test('★ 并发写同一张单时，旁路读者一次都不许读到半截 JSON', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '并发写' })
  const id = created.ticket.id

  const failures = []
  const writes = Array.from({ length: 20 }, (_v, i) =>
    store.reportTicket(id, { outcome: 'progress', evidence: `ev-${i}` }))

  // 一边写一边读：读到 parse 失败 / 读不到，都是原子写没做好
  const reader = (async () => {
    for (let i = 0; i < 40; i += 1) {
      const r = await store.readTicket(id)
      if (r.ok !== true) failures.push(r)
    }
  })()

  const results = await Promise.all([...writes, reader])
  assert.equal(failures.length, 0, `并发读期间出现了 ${failures.length} 次读失败：${JSON.stringify(failures[0] || {})}`)
  assert.ok(results.slice(0, 20).every((r) => r.ok === true), '20 次写必须全部成功')
})

test('★ 同一张单的 20 次并发 report，一条事件都不能丢（同 id 串行链）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '并发事件' })
  const id = created.ticket.id

  await Promise.all(Array.from({ length: 20 }, (_v, i) =>
    store.reportTicket(id, { outcome: 'progress', evidence: `ev-${i}` })))

  const ticket = await store.readTicket(id)
  assert.equal(ticket.ticket.reports, 20, 'reports 计数不能丢')

  const evs = await store.readEvents(id)
  const reports = evs.events.filter((e) => e.type === 'report')
  assert.equal(reports.length, 20, '合法 JSONL 里必须正好 20 条 report（少一条就是丢了写）')

  // 每条 evidence 都要在（不只是条数对）
  const seen = new Set(reports.map((e) => e.payload.evidence))
  for (let i = 0; i < 20; i += 1) assert.ok(seen.has(`ev-${i}`), `ev-${i} 丢了`)
})

// ── 3. 坏文件隔离 ────────────────────────────────────────────────────────

test('★ 损坏的 ticket 文件被跳过并记进 corrupt，不让整个列表失败', async () => {
  const { store, dataDir } = tmpStore()
  const good = await store.openTicket({ title: '好单' })
  // 手写一个坏 JSON（模拟同目录被外部工具写坏 / 磁盘半截）
  fs.writeFileSync(path.join(dataDir, 'tickets', 't-broken01.json'), '{"id":"t-broken01",', 'utf8')

  const listed = await store.listTickets()
  assert.equal(listed.ok, true, '有坏文件也必须整体 ok')
  assert.equal(listed.tickets.length, 1, '好单照常列出')
  assert.equal(listed.tickets[0].id, good.ticket.id)
  assert.deepEqual(listed.corrupt, ['t-broken01'], '坏的那张必须被点名')

  // 精确读它 → 报 CORRUPT_TICKET，而不是含糊的 NOT_FOUND
  const bad = await store.readTicket('t-broken01')
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'CORRUPT_TICKET')

  // 不存在的 id 才是 NOT_FOUND
  const missing = await store.readTicket('t-nosuch01')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')
})

test('索引重建时也把 corrupt 带出来', async () => {
  const { store, dataDir } = tmpStore()
  await store.openTicket({ title: '好单' })
  fs.writeFileSync(path.join(dataDir, 'tickets', 't-broken02.json'), 'not json at all', 'utf8')

  const indexed = await store.readIndex(Date.now())
  assert.equal(indexed.ok, true)
  assert.deepEqual(indexed.index.corrupt, ['t-broken02'])
  assert.equal(indexed.index.count, 1)
})

// ── 4. 索引：可整份重建 ──────────────────────────────────────────────────

test('★ 删掉 index.json 后 readIndex 自动重建（rebuilt:true 且重新落盘）', async () => {
  const { store, dataDir } = tmpStore()
  await store.openTicket({ title: '单 A' })
  await store.openTicket({ title: '单 B' })

  const indexPath = path.join(dataDir, 'index.json')
  const first = await store.readIndex(Date.now())
  assert.equal(first.ok, true)
  assert.equal(first.index.count, 2)
  assert.ok(fs.existsSync(indexPath), '索引应当落盘')

  fs.unlinkSync(indexPath)
  const second = await store.readIndex(Date.now())
  assert.equal(second.ok, true)
  assert.equal(second.rebuilt, true, '索引没了就必须重建')
  assert.equal(second.index.count, 2)
  assert.ok(fs.existsSync(indexPath), '重建后应当重新落盘')
  assert.equal(second.index.schemaVersion, 1)
})

test('★ count 与实际文件数不符时自动重建', async () => {
  const { store, dataDir } = tmpStore()
  await store.openTicket({ title: '单 A' })

  const indexPath = path.join(dataDir, 'index.json')
  await store.readIndex(Date.now())

  // 手工把 count 改错（模拟索引与磁盘漂移）
  const tampered = readJson(indexPath)
  tampered.count = 999
  fs.writeFileSync(indexPath, JSON.stringify(tampered), 'utf8')

  const again = await store.readIndex(Date.now())
  assert.equal(again.rebuilt, true, 'count 对不上就要重建')
  assert.equal(again.index.count, 1)
})

test('索引里带派生好的 stage：报完 waiting-answer 立刻反映出来', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '派生' })
  const id = created.ticket.id

  let indexed = await store.readIndex(Date.now())
  let row = indexed.index.tickets.find((t) => t.id === id)
  assert.equal(row.stage, 'queued', '刚开出来是 queued')

  await store.reportTicket(id, { outcome: 'waiting-answer' })
  indexed = await store.readIndex(Date.now())
  row = indexed.index.tickets.find((t) => t.id === id)
  assert.equal(row.stage, 'waiting-answer', '写完之后索引必须跟着变（写操作会让索引失效）')
  assert.equal(row.lastOutcome, 'waiting-answer')
})

test('rebuildIndex 可以显式整份重建', async () => {
  const { store } = tmpStore()
  await store.openTicket({ title: '单 A' })
  const rebuilt = await store.rebuildIndex(Date.now())
  assert.equal(rebuilt.ok, true)
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.index.count, 1)
})

// ── 5. report 的降级闸与失败计数 ─────────────────────────────────────────

test('★ ready 无 evidence → 实际记 blocked，返回 downgraded:true，事件里留痕', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '降级闸' })
  const id = created.ticket.id

  const reported = await store.reportTicket(id, { outcome: 'ready' })
  assert.equal(reported.ok, true)
  assert.equal(reported.downgraded, true)
  assert.equal(reported.ticket.lastReport.outcome, 'blocked', '落盘的必须是 blocked，不是 ready')

  const onDisk = (await store.readTicket(id)).ticket
  assert.equal(onDisk.lastReport.outcome, 'blocked')

  const evs = await store.readEvents(id)
  const last = evs.events.filter((e) => e.type === 'report').pop()
  assert.equal(last.payload.outcome, 'blocked')
  assert.equal(last.payload.downgraded, true)
  assert.equal(last.payload.requestedOutcome, 'ready')
  assert.match(last.payload.note, /\[downgraded: ready-without-evidence\]/)
})

test('ready 带 evidence 时正常放行（不误伤）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '有证据' })
  const reported = await store.reportTicket(created.ticket.id, {
    outcome: 'ready',
    evidence: 'node --test 全绿：tests 24 / pass 24 / fail 0',
  })
  assert.equal(reported.downgraded, false)
  assert.equal(reported.ticket.lastReport.outcome, 'ready')
})

test('纯空白 evidence 也算没有（不许拿空格糊弄过去）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '空白证据' })
  const reported = await store.reportTicket(created.ticket.id, { outcome: 'ready', evidence: '   \n\t  ' })
  assert.equal(reported.downgraded, true)
  assert.equal(reported.ticket.lastReport.outcome, 'blocked')
})

test('failed 累加 failStreak，其它 outcome 清零；连三次 failed → stage 变 stuck', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '失败计数' })
  const id = created.ticket.id

  await store.reportTicket(id, { outcome: 'failed' })
  await store.reportTicket(id, { outcome: 'failed' })
  assert.equal((await store.readTicket(id)).ticket.failStreak, 2)

  await store.reportTicket(id, { outcome: 'progress' })
  assert.equal((await store.readTicket(id)).ticket.failStreak, 0, '非 failed 必须清零')

  await store.reportTicket(id, { outcome: 'failed' })
  await store.reportTicket(id, { outcome: 'failed' })
  await store.reportTicket(id, { outcome: 'failed' })
  assert.equal((await store.readTicket(id)).ticket.failStreak, 3)

  const indexed = await store.readIndex(Date.now())
  assert.equal(indexed.index.tickets.find((t) => t.id === id).stage, 'stuck', '连续 3 次失败升级为 stuck')
})

// ── 6. 关单 / 换绑 / 查单 ────────────────────────────────────────────────

test('closeTicket 写 closedAt/closedReason + close 事件，文件不删；重复关单幂等', async () => {
  const { store, dataDir } = tmpStore()
  const created = await store.openTicket({ title: '关单' })
  const id = created.ticket.id

  const closed = await store.closeTicket(id, { conclusion: '跑通了，测试全绿' })
  assert.equal(closed.ok, true)
  assert.ok(closed.ticket.closedAt)
  assert.equal(closed.ticket.closedReason, '跑通了，测试全绿')
  assert.ok(fs.existsSync(path.join(dataDir, 'tickets', `${id}.json`)), '关单不删文件')

  const evs = await store.readEvents(id)
  assert.equal(evs.events.filter((e) => e.type === 'close').length, 1)

  // 关过之后不再接受 report
  const rejected = await store.reportTicket(id, { outcome: 'progress' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'ALREADY_CLOSED')

  // 再关一次：不报错，也不重复写事件
  const again = await store.closeTicket(id, { conclusion: '再关一次' })
  assert.equal(again.ok, true)
  assert.equal(again.alreadyClosed, true)
  const after = await store.readEvents(id)
  assert.equal(after.events.filter((e) => e.type === 'close').length, 1, '幂等：不重复写 close 事件')
})

test('closeTicket 的 conclusion 必填（关单要留下为什么关）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '空结论' })
  const rejected = await store.closeTicket(created.ticket.id, { conclusion: '   ' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'BAD_INPUT')
})

test('★ attachTicket 只改 owner/cwd，不动 updatedAt（否则 attach 会偷偷重置 idle 计时）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '换绑', owner: { role: 'lead', sessionId: 'session-a' } })
  const id = created.ticket.id
  const before = created.ticket.updatedAt

  const attached = await store.attachTicket(id, { sessionId: 'session-fake-other' })
  assert.equal(attached.ok, true)
  assert.equal(attached.ticket.owner.sessionId, 'session-fake-other')
  assert.equal(attached.ticket.owner.role, 'lead', '没给 role 就不该动它')
  assert.equal(attached.ticket.updatedAt, before, 'updatedAt 不许被换绑刷新')

  const evs = await store.readEvents(id)
  assert.equal(evs.events.filter((e) => e.type === 'attach').length, 1)
})

test('getTicket 返回 ticket + 最近 N 条事件（旧→新）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '查单' })
  const id = created.ticket.id
  await store.reportTicket(id, { outcome: 'progress', evidence: 'a' })
  await store.reportTicket(id, { outcome: 'progress', evidence: 'b' })

  const got = await store.getTicket(id, { events: 2 })
  assert.equal(got.ok, true)
  assert.equal(got.ticket.id, id)
  assert.equal(got.events.length, 2)
  assert.equal(got.events[1].payload.evidence, 'b', '最后一条应当是最近的')

  const missing = await store.getTicket('t-nosuch02', { events: 2 })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'NOT_FOUND')
})

test('openTicket 的 title 校验：空的不收，超长的拒收（spec §5.1）', async () => {
  const { store } = tmpStore()
  assert.equal((await store.openTicket({ title: '   ' })).code, 'BAD_INPUT')
  assert.equal((await store.openTicket({ title: 'x'.repeat(201) })).code, 'BAD_INPUT')
  assert.equal((await store.openTicket({ title: 'x'.repeat(200) })).ok, true)
})

test('reportTicket 的 outcome 白名单（写错不能被静默接受）', async () => {
  const { store } = tmpStore()
  const created = await store.openTicket({ title: '白名单' })
  const rejected = await store.reportTicket(created.ticket.id, { outcome: 'done' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'BAD_INPUT')
})

// ── 7. 隔离证据：绝不写生产目录 ──────────────────────────────────────────

test('★ 本文件的每一次写都发生在 os.tmpdir() 下，没有一处指向 ~/.dsh-beta', async () => {
  const { store, dataDir } = tmpStore()
  await store.openTicket({ title: '隔离检查' })
  assert.ok(store.dataDir.startsWith(os.tmpdir()), `store.dataDir 必须在临时目录里，实际是 ${store.dataDir}`)
  assert.equal(path.resolve(store.dataDir), path.resolve(dataDir))
  assert.ok(!store.dataDir.includes('.dsh-beta'), '不许出现 .dsh-beta')
})
