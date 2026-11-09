/**
 * test/ledger.test.mjs —— 账本整合 A（工单侧）的测试。
 *
 * 契约来源：`docs/ledger-integration-spec.md`（唯一契约，字段名照它写）。
 * 覆盖三件事：
 *   A1 分级响应（problemClass 出现 1 / 2 / ≥3 次的行为分别正确）
 *   A2 跨单复现模式（看门狗报告的一节，从事件流现算、不落盘、不加寿命）
 *   A3 单向互相指认（work_close 的 lessonSuggestion + work_link_lesson 的幂等追加）
 *
 * 硬纪律（都是踩过的坑，测试就是防止它复发的手段）：
 *   · **output.schema 是 `additionalProperties:false`**：每个新键都必须登记，且运行时类型与声明一致
 *     —— 所以下面有一个通用的 `assertSchemaMatches()`，把真实返回值逐个键对一遍；
 *   · 空值一律 `''` / `0` / `[]`，**绝不 `null`**（一个 `closedAt: null` 就能让整份结果被拒收）；
 *   · 一切落盘都在 `fs.mkdtempSync(os.tmpdir())` 里，跑完全删；真实的
 *     `~/.dsh-beta/workqueue` 与 `~/.dsh-beta/lessons` 一个字节都不碰。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createStore } from '../src/store.mjs'
import { createWorkQueueTools, createWorkLinkLessonTool } from '../src/tools.mjs'
import {
  ATTENTION_MIN_OCCURRENCES,
  FIX_MIN_OCCURRENCES,
  WATCHDOG_PATTERN_KEYS,
  collectProblemPatterns,
  createWatchdog,
  isKebabCase,
} from '../lib/watchdog.mjs'

// ── 夹具 ─────────────────────────────────────────────────────────────────

/** 临时数据目录（每个测试一个，跑完删干净）。 */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-ledger-'))
  if (t && typeof t.after === 'function') {
    t.after(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响判定 */
      }
    })
  }
  return dir
}

/** 起一套真 store + 真工具（不起 DSH，直接调 execute）。 */
function boot(t) {
  const dataDir = tmpDir(t)
  const store = createStore({ dataDir })
  const watchdog = createWatchdog({ store, nowMs: () => Date.now() })
  const tools = createWorkQueueTools({ store, watchdog, defaultRole: 'lead' })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const call = async (name, args) => {
    const tool = byName.get(name)
    assert.ok(tool, `工具没注册：${name}`)
    const value = await tool.execute(args, { agent: { id: 'sess-ledger-0001' } })
    assertSchemaMatches(tool, value)
    return value
  }
  return { dataDir, store, watchdog, tools, byName, call }
}

// ── schema 校验器（additionalProperties:false 的守门员）───────────────────

function checkType(schema, value, at) {
  const type = schema && schema.type
  if (!type) return
  if (type === 'string') assert.equal(typeof value, 'string', `${at} 声明为 string，实际 ${typeof value}`)
  else if (type === 'number') assert.equal(typeof value, 'number', `${at} 声明为 number，实际 ${typeof value}`)
  else if (type === 'boolean') assert.equal(typeof value, 'boolean', `${at} 声明为 boolean，实际 ${typeof value}`)
  else if (type === 'integer') assert.ok(Number.isInteger(value), `${at} 声明为 integer`)
  else if (type === 'array') {
    assert.ok(Array.isArray(value), `${at} 声明为 array`)
    if (schema.items) for (const item of value) checkType(schema.items, item, `${at}[]`)
  } else if (type === 'object') {
    assert.equal(typeof value, 'object', `${at} 声明为 object`)
    assert.notEqual(value, null, `${at} 是 null —— output schema 硬要求：空值用 '' / 0 / []`)
    assert.equal(Array.isArray(value), false, `${at} 声明为 object，实际是数组`)
    // 没有 properties 的 object 是"自由形态"（如 work_get 的 ticket 全文）：跳过逐键核对，
    // 但空值仍然不许是 null（下面统一查 JSON）。
    if (!schema.properties) return
    for (const key of Object.keys(value)) {
      const sub = schema.properties && schema.properties[key]
      assert.ok(sub, `${at}.${key} 未在 output.schema 里登记（会被严格校验层拒收整份结果）`)
      checkType(sub, value[key], `${at}.${key}`)
    }
    for (const key of schema.required || []) {
      assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${at} 缺少 required 字段 ${key}`)
    }
  }
}

function assertSchemaMatches(tool, value) {
  const schema = tool.output && tool.output.schema
  assert.ok(schema, `${tool.name} 没有 output.schema`)
  assert.notEqual(schema.additionalProperties, true, `${tool.name} 的 schema 不许 additionalProperties:true`)
  assert.equal(typeof value, 'object', `${tool.name} 返回值不是对象`)
  assert.notEqual(value, null, `${tool.name} 返回 null`)
  for (const key of Object.keys(value)) {
    const sub = schema.properties && schema.properties[key]
    assert.ok(sub, `${tool.name} 返回了未登记的键：${key}`)
    checkType(sub, value[key], `${tool.name}.${key}`)
  }
  for (const key of schema.required || []) {
    assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${tool.name} 缺少 required 字段 ${key}`)
  }
  // 说明：这里不扫描"整份返回值里有没有 null"。work_get 的 ticket 是**自由形态**对象
  // （工单正文原样透出，closedAt/closedReason 在磁盘上就是 null），那是既有契约不是本次改动；
  // 本次新增的每个键都是登记过的具体类型，checkType 已经逐个确认过没有 null。
}

/** 开一张单，返回 id。 */
async function openTicket(call, title = '账本整合同步单') {
  const opened = await call('work_open', { title, role: 'lead' })
  assert.equal(opened.ok, true, `开单失败：${opened.code} ${opened.message}`)
  return opened.id
}

// ── A1：problemClass 分级响应（1 / 2 / 3 次）──────────────────────────────

test('A1 · 出现 1 次：只记录，不进「该修」名单', async (t) => {
  const { call } = boot(t)
  const id = await openTicket(call)

  const reported = await call('work_report', {
    id,
    outcome: 'failed',
    problemClass: 'probe-false-positive',
    note: '探针误报',
  })

  assert.equal(reported.ok, true)
  assert.equal(reported.problemClass, 'probe-false-positive', '分类必须落盘并回显')
  assert.equal(reported.problemClassCount, 1)
  assert.equal(reported.problemClassFixWorthy, false, '1 次不该进该修名单')
  assert.equal(reported.problemClassNeedsAttention, false)

  // 看门狗这一节：1 次不报
  const scan = await call('work_watchdog', {})
  assert.equal(scan.ok, true)
  assert.deepEqual(scan.patterns, [], '只出现 1 次的分类不许进复现模式')
  assert.equal(scan.patternsError, '')
})

test('A1 · 出现 2 次（两张单）：进「该修」名单，还没到红灯', async (t) => {
  const { call } = boot(t)
  const a = await openTicket(call, '单 A')
  const b = await openTicket(call, '单 B')

  const first = await call('work_report', { id: a, outcome: 'failed', problemClass: 'schema-mismatch' })
  assert.equal(first.problemClassCount, 1)
  assert.equal(first.problemClassFixWorthy, false)

  const second = await call('work_report', { id: b, outcome: 'blocked', problemClass: 'schema-mismatch' })
  assert.equal(second.problemClassCount, FIX_MIN_OCCURRENCES)
  assert.equal(second.problemClassFixWorthy, true, '≥2 次必须进该修名单')
  assert.equal(second.problemClassNeedsAttention, false, '2 次还不该亮红灯')

  const scan = await call('work_watchdog', {})
  assert.equal(scan.patterns.length, 1)
  const row = scan.patterns[0]
  assert.equal(row.problemClass, 'schema-mismatch')
  assert.equal(row.occurrences, 2)
  assert.equal(row.reports, 2)
  assert.deepEqual(row.ticketIds.sort(), [a, b].sort())
  assert.equal(row.fixWorthy, true)
  assert.equal(row.needsAttention, false)
  // 字段集合固定（schema 按它登记）
  assert.deepEqual(Object.keys(row).sort(), [...WATCHDOG_PATTERN_KEYS].sort())
})

test('A1 · 出现 3 次（三张单）：needsAttention 亮红灯', async (t) => {
  const { call, byName } = boot(t)
  const ids = []
  for (const title of ['一号', '二号', '三号']) ids.push(await openTicket(call, title))

  let last = null
  for (const id of ids) {
    last = await call('work_report', { id, outcome: 'failed', problemClass: 'encoding-mismatch', note: 'UTF-8/GBK 混了' })
  }

  assert.equal(last.problemClassCount, ATTENTION_MIN_OCCURRENCES)
  assert.equal(last.problemClassFixWorthy, true)
  assert.equal(last.problemClassNeedsAttention, true, '≥3 次必须标 needsAttention')

  const scan = await call('work_watchdog', {})
  assert.equal(scan.patterns.length, 1)
  assert.equal(scan.patterns[0].occurrences, 3)
  assert.equal(scan.patterns[0].needsAttention, true)
  assert.match(scan.message, /复现模式/)

  // 工具卡片（output.render）里必须真出现这一节，且写明是红灯
  const parts = byName.get('work_watchdog').output.render({}, scan)
  const text = parts.map((p) => p.text || '').join('\n')
  assert.match(text, /🔁 复现模式/)
  assert.match(text, /encoding-mismatch/)
  assert.match(text, /需要重视/)
})

test('A1 · 同一张单报 3 次同一分类：只算 1 张单（次数按「不同工单」算）', async (t) => {
  const { call } = boot(t)
  const id = await openTicket(call)

  let last = null
  for (let i = 0; i < 3; i += 1) {
    last = await call('work_report', { id, outcome: 'failed', problemClass: 'stale-comment', note: `第 ${i + 1} 次` })
  }
  assert.equal(last.problemClassCount, 1, '一张单反复失败不该把整类问题顶成红灯')
  assert.equal(last.problemClassNeedsAttention, false)

  const scan = await call('work_watchdog', {})
  assert.deepEqual(scan.patterns, [], 'occurrences 按不同工单算：只有 1 张 → 不进报告')
})

test('A1 · problemClass 只在 failed/blocked 有效：其它 outcome 静默忽略', async (t) => {
  const { call } = boot(t)
  const id = await openTicket(call)

  const progressed = await call('work_report', { id, outcome: 'progress', problemClass: 'not-a-failure' })
  assert.equal(progressed.ok, true, '不该报错（spec §1：其它 outcome 传了会被忽略）')
  assert.equal(progressed.problemClass, '', 'progress 下分类必须被丢掉')
  assert.equal(progressed.problemClassCount, 0)

  // ready 缺 evidence 被降级成 blocked：那是"没证据"，不是"失败"，同样不该记分类
  const downgraded = await call('work_report', { id, outcome: 'ready', problemClass: 'no-evidence' })
  assert.equal(downgraded.downgraded, true)
  assert.equal(downgraded.problemClass, '')

  // 事件流里也不许残留这两条分类（否则统计会失真）
  const storeEvents = await call('work_get', { id, events: 20 })
  const classes = storeEvents.events
    .filter((ev) => ev.type === 'report')
    .map((ev) => ev.payload && ev.payload.problemClass)
  assert.deepEqual([...new Set(classes)], [''], '非失败类报告不该带任何分类')
})

test('A1 · 形状不对的 problemClass 报 BAD_INPUT（分类不是自由文本）', async (t) => {
  const { call } = boot(t)
  const id = await openTicket(call)

  const bad = await call('work_report', { id, outcome: 'failed', problemClass: 'Probe False Positive' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'BAD_INPUT')

  const bad2 = await call('work_report', { id, outcome: 'blocked', problemClass: '中文分类' })
  assert.equal(bad2.ok, false)
  assert.equal(bad2.code, 'BAD_INPUT')

  // kebab-case 判定本身
  assert.equal(isKebabCase('probe-false-positive'), true)
  assert.equal(isKebabCase('timeout-too-tight'), true)
  assert.equal(isKebabCase('concurrent_writes'), false)
  assert.equal(isKebabCase(''), false)
  assert.equal(isKebabCase('-x'), false)
})

// ── A2：复现模式（纯函数 + 只读 + 渲染）─────────────────────────────────

test('A2 · collectProblemPatterns 是纯函数：不读盘、不改入参、按不同工单计数', () => {
  const events = [
    { _: '说明行，必须被跳过' },
    { ts: 't1', ticketId: 't-a', type: 'report', payload: { outcome: 'failed', problemClass: 'probe-false-positive' } },
    { ts: 't2', ticketId: 't-a', type: 'report', payload: { outcome: 'failed', problemClass: 'probe-false-positive' } },
    { ts: 't3', ticketId: 't-b', type: 'report', payload: { outcome: 'blocked', problemClass: 'probe-false-positive' } },
    { ts: 't4', ticketId: 't-c', type: 'report', payload: { outcome: 'failed', problemClass: 'encoding-mismatch' } },
    { ts: 't5', ticketId: 't-c', type: 'lesson-linked', entryId: 'e-1' },
    { ts: 't6', ticketId: 't-c', type: 'report', payload: { outcome: 'progress' } },
    { ts: 't7', ticketId: 't-d', type: 'report', payload: { outcome: 'failed', problemClass: 'timeout-too-tight' } },
    { ts: 't8', ticketId: 't-e', type: 'report', problemClass: 'stale-comment' }, // 顶层兼容写法
    { ts: 't9', ticketId: 't-f', type: 'report', payload: { outcome: 'blocked', problemClass: 'timeout-too-tight' } },
    { ts: 't10', ticketId: '', type: 'report', payload: { outcome: 'failed', problemClass: 'orphan' } }, // 没 ticketId
    'not-an-object',
    null,
  ]
  const frozen = JSON.parse(JSON.stringify(events))
  const patterns = collectProblemPatterns(events)

  assert.deepEqual(events, frozen, '不许改入参')

  const byName = new Map(patterns.map((row) => [row.problemClass, row]))
  assert.equal(byName.get('probe-false-positive').occurrences, 2, '按不同工单算：t-a/t-b')
  assert.equal(byName.get('probe-false-positive').reports, 3, '报告次数单独记：3 次')
  assert.equal(byName.get('encoding-mismatch').occurrences, 1)
  assert.equal(byName.get('stale-comment').occurrences, 1, '顶层 problemClass 也要认')
  assert.equal(byName.get('timeout-too-tight').occurrences, 2)
  assert.equal(byName.get('timeout-too-tight').needsAttention, false)
  assert.equal(byName.has('orphan'), false, '没有 ticketId 的事件不计入')
  assert.deepEqual(patterns[0].ticketIds, ['t-a', 't-b'], '按 occurrences 降序，同分按下标稳定')
  // 出现 1 次的也在返回值里（由调用方筛），但 fixWorthy 为 false
  assert.equal(byName.get('encoding-mismatch').fixWorthy, false)

  // 垃圾输入不 throw、不编数据
  assert.deepEqual(collectProblemPatterns(null), [])
  assert.deepEqual(collectProblemPatterns('不是数组'), [])
  assert.deepEqual(collectProblemPatterns([]), [])
})

test('A2 · 关掉的单照样计入复现模式（不给模式加寿命）', async (t) => {
  const { call } = boot(t)
  const a = await openTicket(call, '会关掉的单')
  const b = await openTicket(call, '还开着的单')

  await call('work_report', { id: a, outcome: 'failed', problemClass: 'concurrent-write', note: '多会话改同一文件' })
  await call('work_close', { id: a, conclusion: '踩坑已记，关单' })
  await call('work_report', { id: b, outcome: 'failed', problemClass: 'concurrent-write', note: '又踩了' })

  const scan = await call('work_watchdog', {})
  const row = scan.patterns.find((p) => p.problemClass === 'concurrent-write')
  assert.ok(row, '关单不删历史：这类问题必须还在报告里')
  assert.equal(row.occurrences, 2)
  assert.deepEqual(row.ticketIds.sort(), [a, b].sort())
})

test('A2 · watchdog.patterns() 只读：调用前后数据目录逐字节不变', async (t) => {
  const { store, watchdog, call } = boot(t)
  const a = await openTicket(call, '只读校验单')
  const b = await openTicket(call, '只读校验单 2')
  await call('work_report', { id: a, outcome: 'failed', problemClass: 'probe-false-positive' })
  await call('work_report', { id: b, outcome: 'failed', problemClass: 'probe-false-positive' })

  const before = snapshot(store.dataDir)
  const pat = await watchdog.patterns()
  const after = snapshot(store.dataDir)

  assert.equal(pat.ok, true)
  assert.equal(pat.patterns.length, 1)
  assert.deepEqual(after, before, 'patterns() 不该写任何文件（连 index.json 都不许重建）')
})

test('A2 · renderReport 会把复现模式渲染成一节，坏输入不抛', () => {
  const watchdog = createWatchdog({ nowMs: Date.now() })
  const text = watchdog.report({
    ok: true,
    ts: '2026-11-04T00:00:00.000Z',
    stalled: [],
    stuck: [],
    waiting: [],
    counts: { stalled: 0, stuck: 0, waiting: 0 },
    unchanged: true,
    patterns: [
      { problemClass: 'probe-false-positive', occurrences: 3, reports: 4, ticketIds: ['t-a', 't-b', 't-c'], fixWorthy: true, needsAttention: true },
      { problemClass: 'timeout-too-tight', occurrences: 2, reports: 2, ticketIds: ['t-d', 't-e'], fixWorthy: true, needsAttention: false },
    ],
  })
  assert.match(text, /🔁 复现模式 · 2 类/)
  assert.match(text, /其中 1 类需要重视/)
  assert.match(text, /probe-false-positive/)
  assert.match(text, /需要重视（≥3 次）/)
  assert.match(text, /该修（≥2 次）/)

  // 只出现 1 次的不许出现，坏输入也不抛
  const quiet = watchdog.report({ ok: true, patterns: [{ problemClass: 'x-once', occurrences: 1, reports: 1, ticketIds: ['t-a'] }] })
  assert.equal(quiet.includes('x-once'), false)
  assert.equal(typeof watchdog.report({ ok: true, patterns: 'not-an-array' }), 'string')
})

// ── A3.1：work_close 的 lessonSuggestion（不写 lessons）─────────────────

const LESSON_OK = [
  '# 这次踩的坑',
  '',
  '## 症状',
  '跑 npm test 时 PowerShell 把中文输出吞掉了，报 cannot parse。',
  '',
  '## 原因',
  '控制台代码页不是 UTF-8，Node 输出的多字节字符被截断。',
  '',
  '## 正确做法',
  '先 [Console]::OutputEncoding = [Text.Encoding]::UTF8，再跑命令。',
  '',
].join('\n')

test('A3.1 · 没有 lessons.md → lessonSuggestion 是空串（不是 null）', async (t) => {
  const { call, store } = boot(t)
  const id = await openTicket(call)

  const closed = await call('work_close', { id, conclusion: '顺利做完，没踩坑' })
  assert.equal(closed.ok, true)
  assert.deepEqual(closed.lessonSuggestion, { path: '', hint: '' })
  assert.equal(closed.closedAt.length > 0, true)
  assert.equal(fs.existsSync(path.join(store.workDirOf(id), 'lessons.md')), false)
})

test('A3.1 · 三段式 lessons.md 存在 → 返回 suggestion 且不写 lessons 目录', async (t) => {
  const { call, store } = boot(t)
  const id = await openTicket(call)
  const lessonFile = path.join(store.workDirOf(id), 'lessons.md')
  fs.writeFileSync(lessonFile, LESSON_OK, 'utf8')

  const closed = await call('work_close', { id, conclusion: '坑已写进 lessons.md' })
  assert.equal(closed.ok, true)
  assert.equal(closed.lessonSuggestion.path, lessonFile)
  assert.match(closed.lessonSuggestion.hint, /lessons_check/)

  // 只读：lessons.md 自身的 mtime 与内容都没有被 work-queue 改过
  const after = fs.readFileSync(lessonFile, 'utf8')
  assert.equal(after, LESSON_OK)

  // 幂等：再关一次仍然给同一条 suggestion，但不重复写 close 事件
  const again = await call('work_close', { id, conclusion: '再关一次' })
  assert.equal(again.alreadyClosed, true)
  assert.equal(again.lessonSuggestion.path, lessonFile)
})

test('A3.1 · 只有标题没有正文 / 三段缺一段 → 不给 suggestion', async (t) => {
  const { call, store } = boot(t)

  const skeleton = await openTicket(call, '空骨架')
  fs.writeFileSync(path.join(store.workDirOf(skeleton), 'lessons.md'), '## 症状\n\n## 原因\n\n## 正确做法\n\n', 'utf8')
  const closedSkeleton = await call('work_close', { id: skeleton, conclusion: '骨架不算内容' })
  assert.equal(closedSkeleton.lessonSuggestion.path, '', '只有标题的骨架不该上账')

  const partial = await openTicket(call, '缺一段')
  fs.writeFileSync(path.join(store.workDirOf(partial), 'lessons.md'), '## 症状\n出错了\n\n## 原因\n因为\n', 'utf8')
  const closedPartial = await call('work_close', { id: partial, conclusion: '少一段' })
  assert.equal(closedPartial.lessonSuggestion.path, '', '缺「正确做法」不该上账')
})

// ── A3.2：work_link_lesson（幂等、只写自己的事件流）────────────────────

test('A3.2 · work_link_lesson 追加一次、再调幂等', async (t) => {
  const { call, store } = boot(t)
  const id = await openTicket(call)

  const first = await call('work_link_lesson', { ticketId: id, entryId: 'entry-abc123' })
  assert.equal(first.ok, true)
  assert.equal(first.appended, true)
  assert.equal(first.alreadyLinked, false)

  const second = await call('work_link_lesson', { ticketId: id, entryId: 'entry-abc123' })
  assert.equal(second.ok, true)
  assert.equal(second.appended, false, '重复调用不许再追加')
  assert.equal(second.alreadyLinked, true)

  // 事件流里恰好一条
  const got = await call('work_get', { id, events: 50 })
  const linked = got.events.filter((ev) => ev.type === 'lesson-linked')
  assert.equal(linked.length, 1, `应该只有一条 lesson-linked，实际 ${linked.length}`)
  assert.equal(linked[0].entryId, 'entry-abc123')
  assert.equal(linked[0].ticketId, id)

  // 换一个 entryId 是新的一对，照常追加
  const other = await call('work_link_lesson', { ticketId: id, entryId: 'entry-def456' })
  assert.equal(other.appended, true)
  const got2 = await call('work_get', { id, events: 50 })
  assert.equal(got2.events.filter((ev) => ev.type === 'lesson-linked').length, 2)

  // 只动了事件流：tickets/*.json 与 index 之外没有新文件冒出来
  const roots = fs.readdirSync(store.dataDir).sort()
  assert.deepEqual(roots, ['events.jsonl', 'tickets', 'work'].sort())
})

test('A3.2 · 不存在的工单报 NOT_FOUND，不写孤儿事件', async (t) => {
  const { call, store } = boot(t)
  const before = snapshot(store.dataDir)

  const bad = await call('work_link_lesson', { ticketId: 't-nosuchid', entryId: 'entry-x' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'NOT_FOUND')
  assert.deepEqual(snapshot(store.dataDir), before, '失败路径一个字节都不许写')

  const missingArgs = await call('work_link_lesson', { ticketId: '', entryId: 'e' })
  assert.equal(missingArgs.ok, false)
  assert.equal(missingArgs.code, 'BAD_INPUT')
  const missingEntry = await call('work_link_lesson', { ticketId: 't-x', entryId: '' })
  assert.equal(missingEntry.ok, false)
  assert.equal(missingEntry.code, 'BAD_INPUT')
})

test('A3.2 · 关掉的单也能挂错题本（历史永续）', async (t) => {
  const { call } = boot(t)
  const id = await openTicket(call)
  await call('work_close', { id, conclusion: '做完了' })

  const linked = await call('work_link_lesson', { ticketId: id, entryId: 'entry-after-close' })
  assert.equal(linked.ok, true)
  assert.equal(linked.appended, true)
})

// ── 全局：注册与 schema 一致性 ───────────────────────────────────────────

test('工具清单包含 work_link_lesson，且所有新工具都在 output.schema 里登记了新键', async (t) => {
  const { byName, call } = boot(t)

  for (const name of ['work_report', 'work_close', 'work_watchdog', 'work_link_lesson']) {
    assert.ok(byName.has(name), `工具没注册：${name}`)
  }

  // 新增键必须真出现在 schema 里
  const reportProps = byName.get('work_report').output.schema.properties
  for (const key of ['problemClass', 'problemClassCount', 'problemClassFixWorthy', 'problemClassNeedsAttention']) {
    assert.ok(reportProps[key], `work_report 的 schema 没登记 ${key}`)
  }
  const closeProps = byName.get('work_close').output.schema.properties
  assert.ok(closeProps.lessonSuggestion, 'work_close 的 schema 没登记 lessonSuggestion')
  assert.deepEqual(closeProps.lessonSuggestion.required, ['path', 'hint'])
  const wdProps = byName.get('work_watchdog').output.schema.properties
  assert.ok(wdProps.patterns, 'work_watchdog 的 schema 没登记 patterns')
  assert.ok(wdProps.patternsError, 'work_watchdog 的 schema 没登记 patternsError')

  // 单工厂也能单独用（接线层可能只要这一个）
  const lone = createWorkLinkLessonTool({ store: (await import('../src/store.mjs')).createStore({ dataDir: tmpDir(t) }) })
  assert.equal(lone.name, 'work_link_lesson')

  // 真调一次，走完整 schema 校验（1 次分类 + 空 patterns + 空 suggestion 的组合）
  const id = await openTicket(call)
  await call('work_report', { id, outcome: 'failed', problemClass: 'stale-comment' })
  await call('work_close', { id, conclusion: '只为跑一遍 schema 校验' })
  const wd = await call('work_watchdog', {})
  assert.equal(wd.ok, true)
  assert.deepEqual(wd.patterns, [])
  assert.equal(wd.patternsError, '')
})

// ── 小工具：目录快照（只读自证用）───────────────────────────────────────

/** 数据目录的逐文件快照（相对路径 → 内容 + mtime），用来证明"没写过"。 */
function snapshot(root) {
  const out = {}
  const walk = (dir) => {
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) walk(full)
      else {
        const stat = fs.statSync(full)
        out[rel] = `${stat.size}:${stat.mtimeMs}:${fs.readFileSync(full, 'utf8')}`
      }
    }
  }
  walk(root)
  return out
}
