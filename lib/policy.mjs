/**
 * lib/policy.mjs —— M5 授权策略版本化（docs/p2-spec.md §2，契约以那份为准）。
 *
 * 管两份文件，都在 `<dataDir>` 下：
 *
 *   policy.json          当前策略（一份，tmp+rename 原子写）
 *   policy-history.jsonl 历史留档（append-only，每次**变更**一行）
 *
 * 四条约束，改代码前先读：
 *
 * 1. **任何导出函数都不 throw**：一律返回 `{ ok:true, ... }` / `{ ok:false, code, message }`。
 *    工具抛异常会把整轮对话炸掉，这是不可接受的故障模式（和 store.mjs 同一条）。
 *
 * 2. **读没有副作用**：文件不存在时 `read()` 返回默认策略 + `source:'default'`，
 *    绝不顺手把默认值写盘 —— "读一下"变成"改一下"是这类模块最典型的翻车方式。
 *
 * 3. **版本只为真实变更递增**：值没变 → `changed:false`、version 不变、**不写 history**。
 *    否则每点一次"保存"就多一个版本，history 立刻失去"曾经真被改过几次"的意义。
 *
 * 4. **时间一律注入**：`nowMs` 可以是数字（固定时刻）或函数（时钟）。函数体内不读
 *    `Date.now()`；唯一例外是 `opts.nowMs` 没给时的缺省值。
 *
 * 5. **不认识 store**：`update` 只改策略文件，不给工单发事件、不动工单。
 *    给在跑工单发 `policy-changed` 是接线层（P2c）的事 —— 保持本模块零依赖。
 *
 * 另外：本模块全同步（`node:fs` 同步 API）。这不是偷懒 —— update 是"读旧值→算新值→写盘"
 * 的读改写序列，异步版本在两个并发 update 之间会被插入，两边都读到 version 1、都写成
 * version 2，历史里就出现两条同版本记录。同步执行让单进程内的 update 天然串行。
 */

import fs from 'node:fs'
import path from 'node:path'

export const POLICY_FILE_NAME = 'policy.json'
export const POLICY_HISTORY_FILE_NAME = 'policy-history.jsonl'

/** §2.1：acceptMode 只允许这三个值。 */
export const ACCEPT_MODES = Object.freeze(['off', 'observe', 'auto'])

/** §2.1：文件不存在时 read() 返回这份（version 1、observe），并标 source:'default'。 */
export const DEFAULT_POLICY = Object.freeze({ version: 1, acceptMode: 'observe' })

/** 非法 acceptMode 的回退值（§2.1）。 */
const FALLBACK_MODE = 'observe'

/** update 的 meta.updatedBy 缺省值（§2.2）。 */
const DEFAULT_UPDATED_BY = 'unknown'

const TMP_SUFFIX = '.tmp'

/** 是不是合法的 acceptMode。 */
function isMode(value) {
  return typeof value === 'string' && ACCEPT_MODES.includes(value)
}

/** 可空字段统一收敛成字符串：返回 `''` 而不是 null（§1.4，output schema 严格校验）。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/** 把毫秒压成 ISO 字符串。 */
function iso(ms) {
  return new Date(ms).toISOString()
}

/** 异常 → `{ ok:false, code, message }`。 */
function failOf(error, fallbackCode = 'IO_ERROR') {
  const code = error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
    ? error.code
    : fallbackCode
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : String(error)
  return { ok: false, code, message }
}

function badInput(message) {
  return { ok: false, code: 'BAD_INPUT', message }
}

/** 收 patch / meta 这类"应该是对象"的入参：不是对象就当空对象，调用方自己决定怎么处理。 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * 纯函数（§2.2）：把任意来源的原始策略归一化成 `{ version, acceptMode, updatedAt, updatedBy }`。
 *
 * - `version` 必须是 >= 1 的整数，否则回 1（版本从 1 开始，0 和负数没有意义）。
 * - `acceptMode` 不在 ACCEPT_MODES 里就回退 `observe`（§2.1）。
 * - `updatedAt` / `updatedBy` 缺失 → `''`（不是 null）。默认策略没有"谁在什么时候写的"，
 *   这里给空字符串是诚实的；`update` 真正落盘时才写入 ISO 时间与 updatedBy（缺省 'unknown'）。
 */
export function normalizePolicy(raw) {
  const src = asObject(raw) || {}
  const version = Number.isInteger(src.version) && src.version >= 1 ? src.version : 1
  const acceptMode = isMode(src.acceptMode) ? src.acceptMode : FALLBACK_MODE
  return {
    version,
    acceptMode,
    updatedAt: str(src.updatedAt),
    updatedBy: str(src.updatedBy),
  }
}

/**
 * 创建策略读写器。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（policy.json / policy-history.jsonl 所在处）
 * @param {Function} [options.log] 进度日志 `(message: string) => void`
 * @param {number|Function} [options.nowMs] 注入时间（数字=固定时刻，函数=时钟）
 * @returns {{ read: Function, update: Function, history: Function }}
 */
export function createPolicy(options = {}) {
  const opts = asObject(options) || {}
  const dataDir = typeof opts.dataDir === 'string' ? opts.dataDir : ''
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  const injectedNow = opts.nowMs
  const clock = typeof injectedNow === 'function'
    ? injectedNow
    : (typeof injectedNow === 'number' && Number.isFinite(injectedNow) ? () => injectedNow : () => Date.now())

  /** 当前时刻（毫秒）。时钟本身炸了也不许把调用方带下水 → 落到当前时间。 */
  function nowMs() {
    try {
      const value = Number(clock())
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  function paths() {
    return {
      file: path.join(dataDir, POLICY_FILE_NAME),
      history: path.join(dataDir, POLICY_HISTORY_FILE_NAME),
      tmp: path.join(dataDir, POLICY_FILE_NAME + TMP_SUFFIX),
    }
  }

  /**
   * 读盘并归一化。三种结果：
   * - 文件不存在 → 默认策略 + `source:'default'`（**不写盘**）
   * - 合法 JSON 对象 → 归一化 + `source:'file'`
   * - 坏 JSON / 不是对象 → `{ ok:false, code:'BAD_FILE' }`
   *
   * 坏文件不静默当成默认值：policy.json 是"当前生效策略"的唯一权威，把它读成默认
   * observe 会让"看门狗为什么不动"变成一个没法解释的谜。坏掉就如实报出来。
   */
  function readInternal() {
    if (!dataDir) return badInput('createPolicy 需要 dataDir（字符串）')
    const { file } = paths()
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, policy: normalizePolicy(DEFAULT_POLICY), source: 'default' }
      }
      return failOf(error)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return { ok: false, code: 'BAD_FILE', message: `${POLICY_FILE_NAME} 不是合法 JSON：${why}` }
    }
    if (!asObject(parsed)) {
      return { ok: false, code: 'BAD_FILE', message: `${POLICY_FILE_NAME} 的根节点不是对象` }
    }
    return { ok: true, policy: normalizePolicy(parsed), source: 'file' }
  }

  /** §2.2 read()：`{ ok:true, policy, version, source }`，**只读，不写盘**。 */
  function read() {
    try {
      const result = readInternal()
      if (!result.ok) return result
      return { ok: true, policy: result.policy, version: result.policy.version, source: result.source }
    } catch (error) {
      return failOf(error)
    }
  }

  /**
   * §2.2 update(patch, meta)：`{ ok:true, policy, version, fromVersion, changed, historyPath }`。
   *
   * - `patch` 只认 `acceptMode`，别的键忽略；缺 `acceptMode` 或值非法 → `BAD_INPUT`。
   * - 值没变 → `changed:false`、version 不变、`historyPath:''`、**一个字节都不写**。
   * - 值变了 → `version = fromVersion + 1`，tmp+rename 写 policy.json，append 一行 history。
   */
  function update(patch, meta) {
    let tmpPath = ''
    try {
      if (!dataDir) return badInput('createPolicy 需要 dataDir（字符串）')
      const input = asObject(patch)
      if (!input) return badInput('update(patch) 需要一个对象，形如 { acceptMode }')
      if (!Object.prototype.hasOwnProperty.call(input, 'acceptMode')) {
        return badInput(`patch 缺少 acceptMode（这是唯一可改的键，可选值：${ACCEPT_MODES.join(' / ')}）`)
      }
      if (!isMode(input.acceptMode)) {
        return badInput(`acceptMode 只允许 ${ACCEPT_MODES.join(' / ')}，收到 ${JSON.stringify(input.acceptMode)}`)
      }

      const current = readInternal()
      if (!current.ok) return current
      const fromVersion = current.policy.version

      const metaObject = asObject(meta) || {}
      const updatedBy = str(metaObject.updatedBy).trim() || DEFAULT_UPDATED_BY

      if (current.policy.acceptMode === input.acceptMode) {
        // 值没变：版本不动、history 不写（否则每次"保存"都多一个版本）。
        log(`policy: acceptMode 已是 ${input.acceptMode}，未变更（version ${fromVersion}）`)
        return {
          ok: true,
          policy: current.policy,
          version: fromVersion,
          fromVersion,
          changed: false,
          historyPath: '',
        }
      }

      const updatedAt = iso(nowMs())
      const next = {
        version: fromVersion + 1,
        acceptMode: input.acceptMode,
        updatedAt,
        updatedBy,
      }
      const target = paths()
      tmpPath = target.tmp

      fs.mkdirSync(dataDir, { recursive: true })
      // 原子写：先落 .tmp，再 rename 覆盖目标。rename 同卷原子，读者要么看到旧文件、
      // 要么看到新文件，永远看不到半截 JSON。
      fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      fs.renameSync(tmpPath, target.file)
      tmpPath = ''

      const entry = {
        version: next.version,
        fromVersion,
        acceptMode: next.acceptMode,
        updatedAt,
        updatedBy,
      }
      // history 是 append-only 的账：只跟在成功的 rename 之后写，坏不了主文件。
      fs.appendFileSync(target.history, `${JSON.stringify(entry)}\n`, 'utf8')

      log(`policy: version ${fromVersion} -> ${next.version}，acceptMode=${next.acceptMode} by=${updatedBy}`)
      return {
        ok: true,
        policy: next,
        version: next.version,
        fromVersion,
        changed: true,
        historyPath: target.history,
      }
    } catch (error) {
      // 失败时尽力清掉可能残留的 .tmp（清理失败不改变返回值）。
      if (tmpPath) {
        try { fs.rmSync(tmpPath, { force: true }) } catch { /* 清不掉就算了，不改结论 */ }
      }
      return failOf(error)
    }
  }

  /**
   * §2.2 history({ limit })：`{ ok:true, entries, total }`。
   *
   * 整个 jsonl 全读（体积很小，不必只读尾巴）。**坏行跳过**：不是合法 JSON、
   * 或没有可用 version 的行（含空行）都不算一条历史。文件不存在 = 空历史（不报错）。
   * entries 按写入顺序（= 时间正序）返回；`limit` 取**最近** N 条，`total` 是过滤后总数。
   */
  function history(query) {
    try {
      if (!dataDir) return badInput('createPolicy 需要 dataDir（字符串）')
      const options2 = asObject(query) || {}
      const historyPath = paths().history

      let text = ''
      try {
        text = fs.readFileSync(historyPath, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return { ok: true, entries: [], total: 0 }
        return failOf(error)
      }

      const all = []
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let record
        try {
          record = JSON.parse(trimmed)
        } catch {
          continue // 坏行跳过
        }
        if (!asObject(record)) continue
        if (!Number.isInteger(record.version) || record.version < 1) continue
        all.push({
          version: record.version,
          fromVersion: Number.isInteger(record.fromVersion) && record.fromVersion >= 0 ? record.fromVersion : 0,
          acceptMode: isMode(record.acceptMode) ? record.acceptMode : FALLBACK_MODE,
          updatedAt: str(record.updatedAt),
          updatedBy: str(record.updatedBy),
        })
      }

      const total = all.length
      const limit = Number.isInteger(options2.limit) && options2.limit > 0 ? options2.limit : 0
      return { ok: true, entries: limit > 0 ? all.slice(-limit) : all, total }
    } catch (error) {
      return failOf(error)
    }
  }

  return { read, update, history }
}
