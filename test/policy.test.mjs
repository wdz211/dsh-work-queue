/**
 * test/policy.test.mjs —— M5 授权策略版本化（lib/policy.mjs）。
 *
 * 硬约束：所有数据目录都来自 `fs.mkdtempSync(os.tmpdir())`，**绝不碰**
 * `~/.dsh-beta/workqueue`（那是线上真账本，测试写进去就是事故）。
 * 每个 makeDataDir() 都现场断言"目录落在 os.tmpdir() 之内"，防的是以后有人
 * 图省事把 dataDir 改成常量路径。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import {
  ACCEPT_MODES,
  DEFAULT_POLICY,
  POLICY_FILE_NAME,
  POLICY_HISTORY_FILE_NAME,
  createPolicy,
  normalizePolicy,
} from '../lib/policy.mjs'

/** 允许写盘的根：真实路径形式的 tmpdir（Windows 上 os.tmpdir() 可能是 8.3 短名）。 */
const TMP_ROOT = fs.realpathSync(os.tmpdir())

/** 本测试创建的目录，供 after() 统一清理。 */
const createdDirs = []

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论（临时目录，系统会回收）
    }
  }
})

/** 建一个隔离数据目录，并现场断言它确实在 os.tmpdir() 之内。 */
function makeDataDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-policy-${tag}-`))
  createdDirs.push(dir)
  const real = fs.realpathSync(dir)
  const inside = real === TMP_ROOT || real.startsWith(TMP_ROOT + path.sep)
  assert.ok(inside, `dataDir 必须在 os.tmpdir() 之内，实际是：${real}`)
  assert.ok(!real.toLowerCase().includes('.dsh-beta'), `dataDir 不许落在 .dsh-beta 里，实际是：${real}`)
  return dir
}

/** 固定时刻的时间源：2026-11-04T08:00:00.000Z。 */
const FIXED_MS = Date.UTC(2026, 10, 4, 8, 0, 0)
const FIXED_ISO = '2026-11-04T08:00:00.000Z'

function readPolicyFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, POLICY_FILE_NAME), 'utf8'))
}

function historyLines(dir) {
  const file = path.join(dir, POLICY_HISTORY_FILE_NAME)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

test('安全网：dataDir 在 os.tmpdir() 之内，线上 .dsh-beta 不被碰', () => {
  const dir = makeDataDir('safety')
  assert.ok(fs.realpathSync(dir).startsWith(TMP_ROOT))
  // 反证：本测试用的目录里此刻什么都没有（没有既存的线上数据）
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('导出契约：常量与 normalizePolicy 形状符合 spec §2.2', () => {
  assert.equal(POLICY_FILE_NAME, 'policy.json')
  assert.equal(POLICY_HISTORY_FILE_NAME, 'policy-history.jsonl')
  assert.deepEqual([...ACCEPT_MODES], ['off', 'observe', 'auto'])
  assert.deepEqual({ ...DEFAULT_POLICY }, { version: 1, acceptMode: 'observe' })

  // 非法 acceptMode 回退 observe；version 非法回 1；可空字段是 '' 不是 null
  assert.deepEqual(normalizePolicy({ version: 7, acceptMode: 'off', updatedAt: 'x', updatedBy: 'lead' }), {
    version: 7,
    acceptMode: 'off',
    updatedAt: 'x',
    updatedBy: 'lead',
  })
  assert.deepEqual(normalizePolicy({ version: 0, acceptMode: 'yolo' }), {
    version: 1,
    acceptMode: 'observe',
    updatedAt: '',
    updatedBy: '',
  })
  assert.deepEqual(normalizePolicy(null), { version: 1, acceptMode: 'observe', updatedAt: '', updatedBy: '' })
  // 纯函数：不抛异常，任何输入都给一份完整形状
  for (const raw of [undefined, 'observe', 42, [], { version: 2.5 }]) {
    const out = normalizePolicy(raw)
    assert.equal(typeof out.version, 'number')
    assert.ok(ACCEPT_MODES.includes(out.acceptMode))
    assert.equal(typeof out.updatedAt, 'string')
    assert.equal(typeof out.updatedBy, 'string')
  }
})

test('文件不存在：read() 返回默认策略 + source:default，且不写盘', () => {
  const dir = makeDataDir('default')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  const result = policy.read()
  assert.equal(result.ok, true)
  assert.equal(result.source, 'default')
  assert.equal(result.version, 1)
  assert.equal(result.policy.acceptMode, 'observe')
  assert.equal(result.policy.updatedAt, '')
  assert.equal(result.policy.updatedBy, '')

  // 读不许有副作用：目录必须还是空的
  assert.deepEqual(fs.readdirSync(dir), [], 'read() 不许写盘')

  // history 在文件不存在时是空历史，不是错误
  const history = policy.history()
  assert.equal(history.ok, true)
  assert.deepEqual(history.entries, [])
  assert.equal(history.total, 0)
  assert.deepEqual(fs.readdirSync(dir), [])
})

test('非法 acceptMode / 坏 patch 一律 BAD_INPUT，且不落盘', () => {
  const dir = makeDataDir('bad-input')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  const cases = [
    [{ acceptMode: 'yolo' }, '非法值'],
    [{ acceptMode: 'AUTO' }, '大小写不匹配也算非法'],
    [{ acceptMode: '' }, '空串'],
    [{ acceptMode: null }, 'null'],
    [{ acceptMode: 1 }, '数字'],
    [{ mode: 'auto' }, '没有 acceptMode 这个键'],
    [{}, '空对象'],
    [null, 'null patch'],
    ['auto', '字符串 patch'],
  ]
  for (const [patch, why] of cases) {
    const result = policy.update(patch)
    assert.equal(result.ok, false, `${why} 应被拒绝`)
    assert.equal(result.code, 'BAD_INPUT', `${why} 应返回 BAD_INPUT`)
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length > 0)
  }

  assert.deepEqual(fs.readdirSync(dir), [], '被拒绝的 update 不许留下任何文件')
})

test('同值更新：changed:false、版本不变、不写 history、不产生 .tmp', () => {
  const dir = makeDataDir('same-value')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  // 先真改一次，建立 version 2
  const first = policy.update({ acceptMode: 'auto' }, { updatedBy: 'lead' })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(first.version, 2)
  assert.equal(historyLines(dir).length, 1)

  // 再写同一个值：不许升版本，不许写 history
  const second = policy.update({ acceptMode: 'auto' }, { updatedBy: 'someone-else' })
  assert.equal(second.ok, true)
  assert.equal(second.changed, false)
  assert.equal(second.version, 2)
  assert.equal(second.fromVersion, 2)
  assert.equal(second.historyPath, '', '未变更时 historyPath 给空字符串')
  assert.equal(second.policy.updatedBy, 'lead', '未变更时 updatedBy 不该被改写')
  assert.equal(historyLines(dir).length, 1, '未变更不许写 history')

  // 文件内容和版本都还是第一次写的那份
  const onDisk = readPolicyFile(dir)
  assert.equal(onDisk.version, 2)
  assert.equal(onDisk.acceptMode, 'auto')
  assert.equal(onDisk.updatedBy, 'lead')
})

test('不同值更新：version+1、原子写 policy.json、history 多一行', () => {
  const dir = makeDataDir('changed')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  const first = policy.update({ acceptMode: 'off' }, { updatedBy: 'lead' })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(first.fromVersion, 1)
  assert.equal(first.version, 2)
  assert.equal(first.historyPath, path.join(dir, POLICY_HISTORY_FILE_NAME))
  assert.equal(first.policy.acceptMode, 'off')
  assert.equal(first.policy.updatedAt, FIXED_ISO, '时间必须来自注入的 nowMs')
  assert.equal(first.policy.updatedBy, 'lead')

  const onDisk = readPolicyFile(dir)
  assert.deepEqual(onDisk, { version: 2, acceptMode: 'off', updatedAt: FIXED_ISO, updatedBy: 'lead' })

  // 读回来 source:'file'，版本对得上
  const reread = policy.read()
  assert.equal(reread.ok, true)
  assert.equal(reread.source, 'file')
  assert.equal(reread.version, 2)
  assert.equal(reread.policy.acceptMode, 'off')

  // 第二次改：3，history 两行；updatedBy 缺省 'unknown'
  const second = policy.update({ acceptMode: 'auto' })
  assert.equal(second.ok, true)
  assert.equal(second.version, 3)
  assert.equal(second.fromVersion, 2)
  assert.equal(second.policy.updatedBy, 'unknown', 'meta.updatedBy 缺省 unknown')

  const lines = historyLines(dir)
  assert.equal(lines.length, 2)
  const entries = lines.map((line) => JSON.parse(line))
  assert.deepEqual(entries, [
    { version: 2, fromVersion: 1, acceptMode: 'off', updatedAt: FIXED_ISO, updatedBy: 'lead' },
    { version: 3, fromVersion: 2, acceptMode: 'auto', updatedAt: FIXED_ISO, updatedBy: 'unknown' },
  ])

  // 除了这两份文件之外不许有别的东西（尤其没有 .tmp）
  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, [POLICY_HISTORY_FILE_NAME, POLICY_FILE_NAME].sort())
})

test('history()：坏行跳过、正序、limit 取最近 N 条、total 是过滤后总数', () => {
  const dir = makeDataDir('history')
  const file = path.join(dir, POLICY_HISTORY_FILE_NAME)
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ version: 2, fromVersion: 1, acceptMode: 'off', updatedAt: 't2', updatedBy: 'a' }),
      '这不是 JSON {{{',                          // 坏行
      '',
      '   ',
      JSON.stringify({ version: 3, fromVersion: 2, acceptMode: 'auto', updatedAt: 't3', updatedBy: 'b' }),
      '[1,2,3]',                                  // 合法 JSON 但不是对象
      JSON.stringify({ fromVersion: 3, acceptMode: 'off' }),        // 缺 version
      JSON.stringify({ version: 0, fromVersion: 3 }),               // version 非法
      JSON.stringify({ version: 4, fromVersion: 3, acceptMode: 'nope', updatedAt: 7 }), // acceptMode/类型非法 → 归一化
    ].join('\n') + '\n',
    'utf8',
  )

  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  const all = policy.history()
  assert.equal(all.ok, true)
  assert.equal(all.total, 3, '只有 3 行是可用历史（坏行/缺 version 的都跳过）')
  assert.deepEqual(all.entries, [
    { version: 2, fromVersion: 1, acceptMode: 'off', updatedAt: 't2', updatedBy: 'a' },
    { version: 3, fromVersion: 2, acceptMode: 'auto', updatedAt: 't3', updatedBy: 'b' },
    { version: 4, fromVersion: 3, acceptMode: 'observe', updatedAt: '', updatedBy: '' },
  ])

  const limited = policy.history({ limit: 2 })
  assert.equal(limited.ok, true)
  assert.equal(limited.total, 3, 'total 不受 limit 影响')
  assert.deepEqual(limited.entries.map((entry) => entry.version), [3, 4], 'limit 取最近 N 条，仍按正序')

  // limit 非法值当没给
  assert.equal(policy.history({ limit: 0 }).entries.length, 3)
  assert.equal(policy.history({ limit: -5 }).entries.length, 3)
  assert.equal(policy.history({ limit: '2' }).entries.length, 3)
})

test('并发两次 update：版本严格单调递增、history 不重版本', async () => {
  const dir = makeDataDir('concurrent')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  const [a, b] = await Promise.all([
    Promise.resolve().then(() => policy.update({ acceptMode: 'auto' }, { updatedBy: 'a' })),
    Promise.resolve().then(() => policy.update({ acceptMode: 'off' }, { updatedBy: 'b' })),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.deepEqual([a.version, b.version], [2, 3], '两次变更必须拿到不同的版本号')
  assert.deepEqual([a.fromVersion, b.fromVersion], [1, 2])

  const final = policy.read()
  assert.equal(final.version, 3)
  assert.equal(final.policy.acceptMode, 'off')

  const versions = historyLines(dir).map((line) => JSON.parse(line).version)
  assert.deepEqual(versions, [2, 3], 'history 里不许出现同版本两条')

  // 同值并发：第一次真改，后面的都是 changed:false（同一个值不会连升两版）
  const dir2 = makeDataDir('concurrent-same')
  const policy2 = createPolicy({ dataDir: dir2, nowMs: FIXED_MS })
  const results = await Promise.all([
    Promise.resolve().then(() => policy2.update({ acceptMode: 'auto' })),
    Promise.resolve().then(() => policy2.update({ acceptMode: 'auto' })),
    Promise.resolve().then(() => policy2.update({ acceptMode: 'auto' })),
  ])
  assert.deepEqual(results.map((r) => r.changed), [true, false, false])
  assert.deepEqual(results.map((r) => r.version), [2, 2, 2])
  assert.equal(historyLines(dir2).length, 1)
})

test('原子写：写完没有 .tmp 残留，policy.json 永远是完整 JSON', () => {
  const dir = makeDataDir('atomic')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  for (const mode of ['auto', 'off', 'observe', 'auto']) {
    const result = policy.update({ acceptMode: mode }, { updatedBy: 'loop' })
    assert.equal(result.ok, true)
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], `第 ${result.version} 版写完后不许有 .tmp 残留`)
    // 每次写完都能被解析成完整对象（半截 JSON 会让整个工具打挂）
    const onDisk = readPolicyFile(dir)
    assert.equal(onDisk.version, result.version)
    assert.equal(onDisk.acceptMode, mode)
  }

  assert.equal(policy.read().version, 5, '4 次真实变更 → version 5')
  assert.equal(historyLines(dir).length, 4)
})

test('坏 policy.json：read() 返回 BAD_FILE，绝不静默当成默认值', () => {
  const dir = makeDataDir('bad-file')
  fs.writeFileSync(path.join(dir, POLICY_FILE_NAME), '{"version": 2, "acceptMode":', 'utf8')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })

  const result = policy.read()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BAD_FILE')
  assert.ok(result.message.includes(POLICY_FILE_NAME))

  // update 也不能在坏文件上瞎写
  const updated = policy.update({ acceptMode: 'off' })
  assert.equal(updated.ok, false)
  assert.equal(updated.code, 'BAD_FILE')
  // 坏文件保持原样（没被覆盖成默认值）
  assert.equal(fs.readFileSync(path.join(dir, POLICY_FILE_NAME), 'utf8'), '{"version": 2, "acceptMode":')

  // 根节点不是对象也算坏文件
  const dir2 = makeDataDir('bad-file-root')
  fs.writeFileSync(path.join(dir2, POLICY_FILE_NAME), '"observe"', 'utf8')
  assert.equal(createPolicy({ dataDir: dir2 }).read().code, 'BAD_FILE')
})

test('dataDir 缺失或不存在：不 throw，缺失给 BAD_INPUT，不存在则读默认/写时建目录', () => {
  // 没给 dataDir：所有方法都返回 BAD_INPUT，不抛异常
  for (const options of [undefined, {}, { dataDir: 42 }, { dataDir: '' }]) {
    const policy = createPolicy(options)
    for (const method of ['read', 'update', 'history']) {
      const result = method === 'update' ? policy[method]({ acceptMode: 'off' }) : policy[method]()
      assert.equal(result.ok, false, `${method} 在缺 dataDir 时应失败`)
      assert.equal(result.code, 'BAD_INPUT')
    }
  }

  // dataDir 还不存在：read 返回默认（不建目录），update 自己建
  const parent = makeDataDir('missing-dir')
  const dir = path.join(parent, 'nested', 'workqueue')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })
  assert.equal(policy.read().source, 'default')
  assert.equal(fs.existsSync(dir), false, 'read 不许建目录')
  const updated = policy.update({ acceptMode: 'auto' }, { updatedBy: 'lead' })
  assert.equal(updated.ok, true)
  assert.equal(readPolicyFile(dir).acceptMode, 'auto')
})

test('nowMs 注入：数字固定时刻与函数时钟都被尊重，函数体内不读 Date.now()', () => {
  const dir = makeDataDir('clock')
  const clocked = createPolicy({ dataDir: dir, nowMs: () => Date.UTC(2030, 0, 2, 3, 4, 5) })
  const result = clocked.update({ acceptMode: 'off' })
  assert.equal(result.policy.updatedAt, '2030-01-02T03:04:05.000Z')

  // 时钟本身炸了也不许把调用方带下水
  const dir2 = makeDataDir('clock-throws')
  const broken = createPolicy({
    dataDir: dir2,
    nowMs: () => { throw new Error('clock exploded') },
  })
  const survived = broken.update({ acceptMode: 'auto' })
  assert.equal(survived.ok, true)
  assert.equal(typeof survived.policy.updatedAt, 'string')
  assert.ok(!Number.isNaN(Date.parse(survived.policy.updatedAt)))

  // 非法 nowMs（字符串 / NaN）退回系统时钟，不许变成 "Invalid Date"
  const dir3 = makeDataDir('clock-bad')
  const bad = createPolicy({ dataDir: dir3, nowMs: 'yesterday' })
  const okResult = bad.update({ acceptMode: 'auto' })
  assert.equal(okResult.ok, true)
  assert.ok(!Number.isNaN(Date.parse(okResult.policy.updatedAt)))
})

test('update 不碰工单：只写 policy 两份文件，不产生任何 tickets/events/work', () => {
  const dir = makeDataDir('no-tickets')
  const policy = createPolicy({ dataDir: dir, nowMs: FIXED_MS })
  policy.update({ acceptMode: 'auto' }, { updatedBy: 'lead' })

  const names = fs.readdirSync(dir).sort()
  assert.deepEqual(names, [POLICY_HISTORY_FILE_NAME, POLICY_FILE_NAME].sort())
  for (const forbidden of ['tickets', 'events.jsonl', 'index.json', 'work']) {
    assert.equal(fs.existsSync(path.join(dir, forbidden)), false, `不许创建 ${forbidden}`)
  }
})
