/**
 * index.js —— @local/dsh-work-queue 的接线层。
 *
 * 这个文件**只做装配**，不放业务逻辑：
 *   store（落盘） + stage（派生，纯函数） + tools（模型可见工具） + health（系统健康账）
 * 由这里串起来，然后把工具注册进 DSH。
 *
 * ── 为什么这一层要单独存在 ────────────────────────────────────────────────
 * 上面四个模块每一个都能脱离 DSH 单独跑（各自的测试就是这么跑的，全部走 os.tmpdir()）。
 * 唯一需要 DSH 的地方就是「拿到 tools 服务」和「把工具塞进去」，所以那部分被压缩到这一个
 * 文件里。要改业务，改 src/；要改装配，才改这里。
 *
 * ── 关于 acceptMode ──────────────────────────────────────────────────────
 * 配置里的 `acceptMode` 是 P2（授权策略版本化）的落点，P1 **只读取、不执行**：
 * 现在没有任何自动派单/自动开工的路径，所以这个值暂时不改变任何行为。刻意留着并打进日志，
 * 是为了让"我们打算以后要它管什么"这件事在运行时可见，而不是埋在文档里。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from './src/store.mjs'
// 2026-11-08：src/health.mjs 的 napcat-port / qq-ws 两项改为按 link-status.json 的
// activeLink 判定退役，业务改动在 src/；这里只做一次装配层曝光，好让 dsh-unlag（只认 index.js mtime）能重载。
import { createHealthLedger, createRealProbes } from './src/health.mjs'
import { createPolicy } from './lib/policy.mjs'
import { createWatchdog } from './lib/watchdog.mjs'
import { createPoller } from './lib/poller.mjs'
import { createWorkQueueTools } from './src/tools.mjs'

export const name = 'dsh-work-queue'

/**
 * 只 inject `tools` 一个服务。
 *
 * 少 inject 一个就少一个启动期拿不到服务的失败面——这个 profile 上多个插件的服务激活时序
 * 很脆（settings 晚一步，所有等它的插件就 pending 起不来）。这里确实只需要 tools。
 */
export const inject = ['tools']

const LOG_PREFIX = '[work-queue] '

/** 默认数据根目录：`~/.dsh-beta/workqueue`（和 profile 的 DSH_HOME 同一层，不放进工作区）。 */
function defaultDataDir() {
  return path.join(os.homedir(), '.dsh-beta', 'workqueue')
}

/** 递归冻结（`createMessage` 的 deepFreeze 等价物）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * `createUserMessage` 的本地等价实现（逐字照抄 `plugins/dsh-qq-bridge/index.js:433-435`，
 * 那份又对应 `@deepseek-ai/dsh-llm/lib/types/message.js:53 → :35`）。
 * 只在拿不到权威实现时用——消息结构必须与宿主一致，不能自己设计。
 */
function localCreateUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * 找出「该被唤醒的自动化会话」。
 *
 * 只认 `automation-zone.json` 里 `cwd === wakeCwd` 那一条的 sessionId：
 * 猜最近会话或新建会话都等于把消息投进错的地方，宁可放弃唤醒（调用方 warn）。
 * `zones` 的真实形状是「以 cwd 为键的对象」（2026-11-06 实读），数组形式只是兜底。
 */
function resolveWakeSessionId(wakeCwd) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta')
  try {
    const zone = JSON.parse(fs.readFileSync(path.join(home, 'automation-zone.json'), 'utf8'))
    const zones = zone && zone.zones && typeof zone.zones === 'object' ? zone.zones : null
    if (!zones) return ''
    const entry = Array.isArray(zones)
      ? zones.find((row) => row && row.cwd === wakeCwd)
      : zones[wakeCwd]
    const id = entry && typeof entry.sessionId === 'string' ? entry.sessionId.trim() : ''
    return id
  } catch {
    return ''
  }
}

function normalizeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const healthRaw = raw.health && typeof raw.health === 'object' ? raw.health : {}
  const wdRaw = raw.watchdog && typeof raw.watchdog === 'object' ? raw.watchdog : {}
  const positive = (v, fb) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : fb
  }

  return {
    enabled: raw.enabled !== false,
    // 空字符串 = 用默认目录（配置文件里留空是刻意的：换机器不用改配置）
    dataDir: typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir.trim() : defaultDataDir(),
    defaultRole: typeof raw.defaultRole === 'string' && raw.defaultRole ? raw.defaultRole : 'lead',
    // ⚠ 这里只是**首次引导**的初始档位。真正生效的档位在 `<dataDir>/policy.json`（M5 版本化），
    // 有那个文件时一律以它为准；配置文件这个值只在策略文件还不存在时被写进去当 version 1。
    acceptMode: ['off', 'observe', 'auto'].includes(raw.acceptMode) ? raw.acceptMode : 'observe',
    health: {
      enabled: healthRaw.enabled !== false,
      // 静默巡检间隔（分钟），**0 = 关**。默认 10 分钟：探活已经不占 LLM 回合了，
      // 心跳密一点只会让「连续 3 次失败判 critical」从 1.5 小时缩到 30 分钟，不花 token。
      intervalMinutes: Number.isFinite(Number(healthRaw.intervalMinutes)) ? Number(healthRaw.intervalMinutes) : 10,
    },
    // 唤醒投给哪个自动化会话：先按这个工作目录去 automation-zone.json 的 zones 里找 sessionId。
    // 刻意不做成「猜最近会话」——猜错就是把消息投进别人的对话。
    wakeCwd: typeof raw.wakeCwd === 'string' && raw.wakeCwd.trim()
      ? raw.wakeCwd.trim()
      : process.cwd(),
    watchdog: {
      idleMs: positive(wdRaw.idleMs, 2 * 3600_000),
      waitingMs: positive(wdRaw.waitingMs, 24 * 3600_000),
    },
  }
}

/**
 * @param {import('cordis').Context} ctx
 * @param {unknown} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const log = ctx.logger

  if (!config.enabled) {
    // 关掉也要留一行：否则"工具为什么不出现"就变成猜。
    log.info(`${LOG_PREFIX} 配置里 enabled=false，跳过注册（不装工具）`)
    return
  }

  /**
   * 取服务：属性直取优先，**兜底必须用 `ctx.get(name, false)`**。
   *
   * cordis 的 `ReflectService.get(name, strict = true)` 内部是
   * `if (strict && impl.fiber.state !== 2) return;`（@deepseek-ai/cordis/lib/index.js:765-767）
   * —— 服务提供者 fiber 尚未激活（启动期正是这个状态）时**直接返回 undefined**。
   * 而 ctx 的 proxy get trap 在「prop 在 inject 里、但当前上下文不是 active」时会抛
   * `cannot get required service "<name>" in inactive context`（同文件 :687-689）。
   *
   * 所以启动期默认的两条路都是死的，只有 `strict = false` 这条不看 state 的路能拿到实现。
   */
  const service = (serviceName) => {
    try {
      const direct = ctx[serviceName]
      if (direct !== undefined && direct !== null) return direct
    } catch {
      // inactive context：属性访问要求服务已激活，启动期必然抛，属预期，继续往下兜。
    }
    if (typeof ctx.get !== 'function') return undefined
    try {
      const loose = ctx.get(serviceName, false)
      if (loose !== undefined && loose !== null) return loose
    } catch {
      // get 本身也可能因 isolate 不匹配等原因抛，交给下面返回 undefined。
    }
    return ctx.get(serviceName)
  }

  const tools = service('tools')
  if (!tools || typeof tools.register !== 'function') {
    // 如实说清楚缺的是什么，而不是静默放弃
    log.warn(`${LOG_PREFIX} 拿不到 tools 服务，跳过注册（这不影响已有插件，本插件等于未启用）`)
    return
  }

  // ── 装配 ────────────────────────────────────────────────────────────────
  let store
  try {
    store = createStore({ dataDir: config.dataDir })
  } catch (err) {
    log.warn(`${LOG_PREFIX} store 创建失败（dataDir=${config.dataDir}）：${err && err.message ? err.message : err}`)
    return
  }

  let health = null
  if (config.health.enabled) {
    try {
      // 必须显式传 probes：createHealthLedger 在 opts.probes 缺失时**不会**自动回落到
      // 真实探针，而是拿一个空对象，七项就全报「探针未注入」（实测踩过，
      // 表现是 health_check 七行 unknown 且看起来"一切正常"）。
      health = createHealthLedger({ dataDir: config.dataDir, probes: createRealProbes(), log })
    } catch (err) {
      // 健康账起不来不该拖垮工单工具本身
      log.warn(`${LOG_PREFIX} 健康账创建失败，health_check 将不可用：${err && err.message ? err.message : err}`)
      health = null
    }
  }

  // ── M5 授权策略 ─────────────────────────────────────────────────────────
  // `policy.json` 是权威；配置文件里的 acceptMode 只在策略文件还不存在时被写成 version 1。
  let policy = null
  try {
    policy = createPolicy({ dataDir: config.dataDir, log, nowMs: () => Date.now() })
    const boot = policy.read()
    if (boot.ok === true && boot.source === 'default' && boot.policy.acceptMode !== config.acceptMode) {
      const seeded = policy.update({ acceptMode: config.acceptMode }, { updatedBy: 'bootstrap' })
      if (seeded.ok === true) {
        log.info(`${LOG_PREFIX} 策略文件不存在，已用配置档位初始化为 acceptMode=${config.acceptMode}`)
      }
    }
  } catch (err) {
    log.warn(`${LOG_PREFIX} 策略模块创建失败，work_policy 将不可用：${err && err.message ? err.message : err}`)
    policy = null
  }

  // ── 看门狗（只读扫描）──────────────────────────────────────────────────
  // **必须给时钟**：watchdog 刻意不读 Date.now()，没注入时 ts='' 且 stalled 恒为空。
  let watchdog = null
  try {
    watchdog = createWatchdog({
      store,
      nowMs: () => Date.now(),
      idleMs: config.watchdog.idleMs,
      waitingMs: config.watchdog.waitingMs,
    })
  } catch (err) {
    log.warn(`${LOG_PREFIX} 看门狗创建失败，work_watchdog 将不可用：${err && err.message ? err.message : err}`)
    watchdog = null
  }

  // ── 静默巡检：把探活从 LLM 回合里搬回进程内 ───────────────────────────────
  // 原来那条 `*/30` 的 cron 每轮烧一个完整回合去调 health_check + work_watchdog（48 轮/天、
  // 80–100 KB/轮），多数时候只回一句「无异常」。这里让纯代码每 N 分钟探一次，
  // **只在状态跃迁时**叫醒 agent（判据全在 lib/poller.mjs）。
  // `config.health.intervalMinutes` 从此真正生效（以前定义了却没人读）。
  if (config.health.enabled && config.health.intervalMinutes > 0 && health && watchdog) {
    // createUserMessage：优先权威实现，拿不到用逐字等价的本地实现（与 qq-bridge 同一条路）。
    let messageFactory = localCreateUserMessage
    void import('@deepseek-ai/dsh-llm')
      .then((mod) => {
        if (mod && typeof mod.createUserMessage === 'function') messageFactory = mod.createUserMessage
      })
      .catch(() => {
        /* 裸 node 里解析不到这个包是预期，本地实现等价 */
      })

    /**
     * 投递一次唤醒。链路照生产在用的那条（`plugins/dsh-qq-bridge/index.js:748-765`）：
     * `resolveAgent` → `followup`（同步，不 await）→ `await sessions.flush`。
     * 服务软取，任何一环缺失都只 warn 返回——唤醒是增值功能，不能让它挡住插件装载。
     */
    const deliverWake = async (text) => {
      const sessionController = service('sessionController')
      const sessions = service('sessions')
      if (!sessionController || typeof sessionController.resolveAgent !== 'function') {
        log.warn(`${LOG_PREFIX} 拿不到 sessionController，放弃本次唤醒`)
        return false
      }
      if (!sessions || typeof sessions.flush !== 'function') {
        log.warn(`${LOG_PREFIX} 拿不到 sessions，放弃本次唤醒（无法确认持久化）`)
        return false
      }
      const sessionId = resolveWakeSessionId(config.wakeCwd)
      if (!sessionId) {
        log.warn(
          `${LOG_PREFIX} automation-zone.json 里没有 cwd=${config.wakeCwd} 的自动化会话，`
            + '放弃本次唤醒（不猜、不新建会话）',
        )
        return false
      }
      try {
        const resolved = await sessionController.resolveAgent(sessionId)
        if (!resolved || resolved.error || !resolved.agent) {
          const why = resolved && resolved.error
            ? (resolved.error.message || String(resolved.error))
            : '没有 agent'
          log.warn(`${LOG_PREFIX} 唤醒目标 ${sessionId} 解析失败：${why}`)
          return false
        }
        // source 必填：v4 会话校验要求每条 durable message 带 producer-owned kind。
        // 缺 source 的 inbox splice 会让整个会话判 corrupt、历史打不开（2026-11-07 实测）。
        const message = messageFactory({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'work-queue' } })
        resolved.agent.followup(message) // 同步方法，不 await
        // **必须查返回值**：`sessions.flush` 只在真有持久化回调接走时才为真（生产路径
        // `dsh-schedule:1598` 就是 `if (!await sessions.flush(...)) throw`）。不查它，
        // 「没落盘」会被当成「已送达」，poller 那边就不再重试了。
        const flushed = await sessions.flush(resolved.agent.session)
        if (!flushed) {
          log.warn(`${LOG_PREFIX} 唤醒已进箱但 flush 未确认落盘，按投递失败算（下次巡检会重试）`)
          return false
        }
        return true
      } catch (err) {
        log.warn(`${LOG_PREFIX} 唤醒投递失败：${err && err.message ? err.message : err}`)
        return false
      }
    }

    try {
      const poller = createPoller({ health, watchdog, wake: deliverWake, log, now: () => Date.now() })
      poller.start(config.health.intervalMinutes * 60_000)
      // 插件卸载/重载时把定时器收掉，否则重载一次就多一个探活循环
      ctx.effect(() => () => poller.stop(), 'work-queue: dispose poller')
      log.info(
        `${LOG_PREFIX} 静默巡检：每 ${config.health.intervalMinutes} 分钟探活一次（0=关），只在状态跃迁时唤醒 agent`,
      )
    } catch (err) {
      log.warn(`${LOG_PREFIX} 静默巡检启动失败（不影响工具本身）：${err && err.message ? err.message : err}`)
    }
  } else {
    log.info(
      `${LOG_PREFIX} 静默巡检：关（health.enabled=${config.health.enabled}`
        + ` intervalMinutes=${config.health.intervalMinutes} health=${health ? 'ok' : 'null'}`
        + ` watchdog=${watchdog ? 'ok' : 'null'}）`,
    )
  }

  let toolList = []
  try {
    toolList = createWorkQueueTools({ store, health, policy, watchdog, defaultRole: config.defaultRole })
  } catch (err) {
    log.warn(`${LOG_PREFIX} 工具构建失败：${err && err.message ? err.message : err}`)
    return
  }

  let registered = 0
  for (const tool of toolList) {
    try {
      tools.register(tool)
      registered += 1
    } catch (err) {
      // 单个工具注册失败不该让其余工具也装不上
      log.warn(`${LOG_PREFIX} 注册工具 ${tool && tool.name} 失败：${err && err.message ? err.message : err}`)
    }
  }

  const names = toolList.slice(0, registered).map((t) => t.name).join(' / ')
  log.info(`${LOG_PREFIX} 已注册 ${registered} 个工具：${names}`)

  // 这三行刻意都打：数据在哪、判据是什么、未来会由谁管——出问题时第一眼就能核对，
  // 不用翻配置文件猜。
  log.info(`${LOG_PREFIX} 数据目录：${config.dataDir}（工单是一单一文件，stage 每次派生、不落盘）`)
  log.info(
    `${LOG_PREFIX} ready 无 evidence 自动降级为 blocked；连续 3 次 failed 判 stuck；`
      + `健康账${health ? `已启用（连续 3 次失败才算 critical）` : '未启用'}`,
  )
  const effMode = policy
    ? (() => {
        const r = policy.read()
        return r.ok === true ? r.policy.acceptMode : config.acceptMode
      })()
    : config.acceptMode
  log.info(
    `${LOG_PREFIX} acceptMode=${effMode}（auto 尚未实现，读到会自动降级为 observe）；`
      + `看门狗${watchdog
        ? `已就绪（停滞 ${Math.round(config.watchdog.idleMs / 60000)} 分钟 / 等待 ${Math.round(config.watchdog.waitingMs / 3600000)} 小时，只读不改单）`
        : '未启用'}`,
  )
}
