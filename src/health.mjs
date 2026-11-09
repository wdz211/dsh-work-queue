/**
 * src/health.mjs —— M4 系统健康账（探活 + 连续失败计数 + report.md）
 *
 * 契约见 docs/p1-spec.md §6 与 §8 验收③。这里只做三件事：
 *   1. 跑一组探针，把每条结果归一成 ok / warn / critical / unknown；
 *   2. 某项**连续 3 次**探测失败才升 critical（第 1、2 次只是 warn）；
 *   3. 落盘：重写 report.md、追加 health.jsonl 一行。
 *
 * 升级动作**只写盘**：不重启任何东西、不发消息、不 throw。看门狗（P2）才做提醒。
 *
 * 三态是本模块最要紧的语义（§6.2 最后一条）：
 *   ok:true  = 健康         → 计数清零
 *   ok:false = 探测失败     → 计数 +1，满 3 升 critical
 *   ok:null  = 测不出来     → **不算失败**，计数清零，状态 unknown
 * 路径不存在、文件还没生成、探针自己抛异常，都归 unknown。不能因为「文件没生成」
 * 就报系统挂了——那会让健康账变成噪声源，人一旦不信它，它就没有存在价值。
 *
 * 探针可注入（createHealthLedger({ probes })）是刻意的：测试只喂假探针，
 * 绝不去连真端口、读真状态文件；生产用 createRealProbes() 给的那一套。
 */

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** 七项监控（§6.1，名称必须一字不差，别改） */
export const MONITOR_NAMES = Object.freeze([
  'qq-ws',
  'napcat-port',
  'dsh-port',
  'effect-queue',
  'schedule-last',
  'heartbeat-seed',
  'zone-orphan',
])

/** 连续失败到这个次数才升 critical（§6.2 硬要求） */
export const CRITICAL_THRESHOLD = 3

const DEFAULT_PROBE_TIMEOUT_MS = 5000
const TAIL_BYTES = 4 * 1024 * 1024 // 读 JSONL 只读尾部，别为一行状态把整个文件吞进来
const EFFECT_QUEUE_STALE_MS = 60_000 // pending 超过 dueAt 60 秒才算积压（§6.1）
const EFFECT_QUEUE_MAX_BACKLOG = 5 // 积压 > 5 条判失败
const SCHEDULE_MAX_SILENCE_MS = 24 * 3600_000
const HEARTBEAT_SEED_MAX_SILENCE_MS = 6 * 3600_000
const BRIDGE_STALE_MS = 15 * 60_000 // 桥接 sidecar 超过这么久没写 = 进程疑似不在
const NDJSON_MARKER = '{"_":"不是给模型读的状态文件：M4 健康账每次探活的记录，只看最后几行判断趋势，不要当事实背诵"}'

// ---------------------------------------------------------------- 小工具

function noop() {}

function safeLog(log, msg) {
  try {
    if (typeof log === 'function') log(msg)
  } catch {}
}

/** nowMs 允许是数字、函数，或干脆不给 */
function nowFn(nowMs) {
  if (typeof nowMs === 'function') {
    return () => {
      try {
        const v = Number(nowMs())
        return Number.isFinite(v) ? v : Date.now()
      } catch {
        return Date.now()
      }
    }
  }
  const fixed = Number(nowMs)
  if (Number.isFinite(fixed)) return () => fixed
  return () => Date.now()
}

function statSafe(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : null
  } catch {
    return null
  }
}

/** 读文件尾部（大文件只读最后一截；开头那半行会让 JSON.parse 失败，调用方自己跳过） */
function readTextTail(file, maxBytes = TAIL_BYTES) {
  const st = statSafe(file)
  if (!st || !st.isFile() || st.size <= 0) return ''
  const start = Math.max(0, st.size - maxBytes)
  const len = st.size - start
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
  }
}

/** 把 JSONL 尾部切成对象数组，坏行直接跳过（半截行、加密行、手改行都在这消失） */
function parseJsonl(raw) {
  const out = []
  if (!raw) return out
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const obj = JSON.parse(s)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj)
    } catch {}
  }
  return out
}

function fmtDuration(ms) {
  const v = Math.max(0, Number(ms) || 0)
  if (v < 60_000) return `${Math.round(v / 1000)} 秒`
  if (v < 3600_000) return `${Math.round(v / 60_000)} 分钟`
  return `${(v / 3600_000).toFixed(1)} 小时`
}

function fmtLocal(ts) {
  const d = new Date(Number(ts) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function escapeCell(text) {
  return String(text ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

// ---------------------------------------------------------------- 底层探测手段

/** TCP 连通性：连上就算通，连不上/超时都算断。**不调 HTTP API**——见 napcat-port 的注释。 */
function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let sock
    const finish = (ok, detail) => {
      if (done) return
      done = true
      try {
        if (sock) sock.destroy()
      } catch {}
      resolve({ ok, detail })
    }
    try {
      sock = net.connect({ host, port })
    } catch (e) {
      finish(false, `TCP ${host}:${port} 建连异常：${e && e.message ? e.message : e}`)
      return
    }
    sock.setTimeout(timeoutMs, () => finish(false, `TCP ${host}:${port} 超时 ${timeoutMs}ms`))
    sock.once('connect', () => finish(true, `TCP ${host}:${port} 可连接`))
    sock.once('error', (e) => finish(false, `TCP ${host}:${port} 连接失败：${(e && (e.code || e.message)) || 'unknown'}`))
  })
}

/** 只问「这个地址上有人应答吗」，不管状态码：401/403 也证明服务活着 */
function httpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok, detail) => {
      if (done) return
      done = true
      resolve({ ok, detail })
    }
    let req
    try {
      req = http.get(url, { timeout: timeoutMs }, (res) => {
        const code = Number(res.statusCode) || 0
        try {
          res.resume()
        } catch {}
        finish(true, `${url} 有应答（HTTP ${code}）`)
      })
    } catch (e) {
      finish(false, `${url} 请求建不起来：${e && e.message ? e.message : e}`)
      return
    }
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy()
      } catch {}
      finish(false, `${url} 无应答（超时 ${timeoutMs}ms）`)
    })
    req.on('error', (e) => finish(false, `${url} 连接失败：${(e && (e.code || e.message)) || 'unknown'}`))
  })
}

// ---------------------------------------------------------------- 真实探针

/**
 * 生产用真实探针。注意：**创建时零 IO**——只算路径，真正读盘发生在探针被调用那一刻。
 * 这样测试可以只检查 shape 而不碰任何真实状态文件。
 */
export function createRealProbes(options = {}) {
  const unknownAll = (why) => {
    const out = {}
    for (const name of MONITOR_NAMES) out[name] = async () => ({ ok: null, detail: why })
    return out
  }
  try {
    const opts = options && typeof options === 'object' ? options : {}
    const now = nowFn(opts.nowMs)
    const home = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta')
    // 「工作区」目录：QQ 链路的运行状态文件落在这里。用 DSH_WORKSPACE 显式指定，
    // 没有就退到当前工作目录——不写死任何本机绝对路径。
    const workspace = () => process.env.DSH_WORKSPACE || process.cwd()
    const files = {
      bridgeStateFile: opts.bridgeStateFile || path.join(workspace(), '.qq-bridge-state.json'),
      bridgeAliveFile: opts.bridgeAliveFile || path.join(workspace(), '.proactive-state.json'),
      effectQueueFile: opts.effectQueueFile || path.join(workspace(), '.effect-queue.jsonl'),
      scheduleFile: opts.scheduleFile || path.join(home(), 'storages', 'schedule.json'),
      heartbeatLogFile: opts.heartbeatLogFile || path.join(home(), 'heartbeat-data', 'logs', 'heartbeat.jsonl'),
      seedReportFile: opts.seedReportFile || path.join(home(), 'heartbeat-data', 'seed_report.jsonl'),
      zoneStateFile: opts.zoneStateFile || path.join(home(), 'automation-zone.json'),
      dshLogsDir: opts.dshLogsDir || path.join(home(), 'logs'),
      linkStatusFile: opts.linkStatusFile || path.join(home(), 'link-status.json'),
    }
    const napcatPort = Number(opts.napcatPort) > 0 ? Number(opts.napcatPort) : 3001
    const bridgePushPort = Number(opts.bridgePushPort) > 0 ? Number(opts.bridgePushPort) : 39310
    const tcpTimeoutMs = Number(opts.tcpTimeoutMs) > 0 ? Number(opts.tcpTimeoutMs) : 1500
    const httpTimeoutMs = Number(opts.httpTimeoutMs) > 0 ? Number(opts.httpTimeoutMs) : 2000
    const dshBaseUrl = typeof opts.dshBaseUrl === 'string' ? opts.dshBaseUrl.trim() : ''
    let dshMisses = 0 // dsh-port 的「连续两次发现不到才判失败」内部闸（见该探针注释）

    /** schedule.json 的 tasks 表（load-once，只读；§9 明确绝不写它） */
    const loadScheduleTaskIds = () => {
      const obj = readJsonSafe(files.scheduleFile)
      const tasks = obj && obj.tables && obj.tables.tasks
      if (!tasks || typeof tasks !== 'object') return null
      return tasks
    }

    const probes = {
      /**
       * qq-ws：桥接进程活着吗。读桥接自己落的 sidecar（.proactive-state.json，每个自主 tick 都写），
       * 状态文件（.qq-bridge-state.json）只取 current / lastInboundAt 当详情。
       * 取舍：这里不做 ws 升级握手（无依赖、空 accessToken 下握手也证明不了业务面），
       * 链路另一头由 napcat-port 的 TCP 探把守。
       */
      'qq-ws': async () => {
        // 2026-11-08：主力链路已换官方 Bot（link-status.json 的 activeLink=qqbot），NapCat 桥接退役。
        // 桥接进程不在是**预期**——继续按 critical 记账只会让退役链路的尸体每天报一次警。
        // 判据只认权威源；读不到 / 没有 activeLink 时退回老口径真探（fail-open，不丢监控）。
        const ls = readJsonSafe(files.linkStatusFile)
        const active = ls && typeof ls.activeLink === 'string' ? ls.activeLink.trim() : ''
        if (active && active !== 'qq') {
          return { ok: null, detail: `旧 NapCat 桥接链路已退役（activeLink=${active}），桥接进程与 39310 不在属预期，本项不参与判定` }
        }
        const alive = statSafe(files.bridgeAliveFile)
        const state = readJsonSafe(files.bridgeStateFile)
        const cur = state && state.current ? `current=${state.current}` : '状态文件无 current'
        const inbound = state && state.lastInboundAt ? `lastInboundAt=${state.lastInboundAt}` : '无 lastInboundAt'
        const ageMs = alive ? now() - alive.mtimeMs : Infinity

        // 2026-11-04 修误报：原来只拿 sidecar 的 mtime 判死活，但 .proactive-state.json
        // **不是**每个自主 tick 都写 —— 只在跨天计数归零或真做了决定时才落盘
        // （onebot-bridge.mjs 的 saveProactiveState 调用点都带条件），所以消息静默期
        // 它本来就会好几个小时不动。实测 18:30 报「3.3 小时未更新」、19:00 报「28 分钟」，
        // 而当时桥接进程健在、日志还在写、39310 端口正在听 —— 全是假警报。
        // 现在先用**强信号**：桥接自己的 push server 端口。进程活着就在听，跟有没有消息无关。
        const push = await tcpProbe('127.0.0.1', bridgePushPort, tcpTimeoutMs)
        if (push.ok) {
          const fresh = alive ? `sidecar ${fmtDuration(ageMs)}前更新` : '无 sidecar'
          return { ok: true, detail: `桥接 push 端口 ${bridgePushPort} 可连接（${fresh}）；${cur}；${inbound}` }
        }
        // push 端口不听时，sidecar 新不新鲜才轮到它说话
        if (!alive) {
          return { ok: null, detail: `桥接 sidecar 不存在，且 push 端口 ${bridgePushPort} 不可连接：${files.bridgeAliveFile}` }
        }
        if (ageMs > BRIDGE_STALE_MS) {
          return { ok: false, detail: `桥接 push 端口 ${bridgePushPort} 不可连接，sidecar 也已 ${fmtDuration(ageMs)} 未更新（阈值 ${fmtDuration(BRIDGE_STALE_MS)}），进程疑似不在；${cur}` }
        }
        return { ok: true, detail: `桥接 sidecar ${fmtDuration(ageMs)}前更新（push 端口不可连接，按 sidecar 判活）；${cur}；${inbound}` }
      },

      /**
       * napcat-port：**裸 TCP 连接**端口，不调任何 OneBot API。
       * 为什么不用 get_status：QQ 掉线时它仍报 online:true / good:true（记忆 28e22346），
       * 拿它当判据等于把「NapCat 进程在」错当成「QQ 在线」。TCP 连得上才说明 onebot ws
       * 服务真的在听；真在线与否留给桥接自己的探活（get_stranger_info 那条路）。
       */
      'napcat-port': async () => {
        // 2026-11-08 起主力链路换成官方 Bot（link-status.json 的 activeLink=qqbot），NapCat 退役，
        // 3001 没人听是**预期**而不是故障；继续按 critical 记账会让健康页永久飘红、把真异常淹掉。
        // 判据只认权威源 link-status.json；读不到 / 没 activeLink 时退回老口径真探（fail-open，不丢监控）。
        const ls = readJsonSafe(files.linkStatusFile)
        const active = ls && typeof ls.activeLink === 'string' ? ls.activeLink.trim() : ''
        if (active && active !== 'qq') {
          return { ok: null, detail: `NapCat 链路已退役（activeLink=${active}），3001 无监听属预期，本项不参与判定` }
        }
        return tcpProbe('127.0.0.1', napcatPort, tcpTimeoutMs)
      },

      /**
       * dsh-port：DSH Desktop 是 port:0，每次启动随机（记忆 745a0de8），所以只能运行时发现：
       * 读最新的 desktop-next-*.jsonl，取最后一条 `dsh web: http://127.0.0.1:<port>`，再真探一下。
       * §6.1 要求「连续两次发现不到」才算失败 → 第一次 miss 返回 unknown（测不出来，不给结论），
       * 第二次才 false；拿到端口就直接由 HTTP 应答判定。
       */
      'dsh-port': async () => {
        if (dshBaseUrl) {
          const r = await httpProbe(dshBaseUrl, httpTimeoutMs)
          dshMisses = r.ok ? 0 : dshMisses + 1
          return { ok: r.ok, detail: `配置直连 ${r.detail}` }
        }
        let list = []
        try {
          list = fs
            .readdirSync(files.dshLogsDir)
            .filter((n) => /^desktop-next-.*\.jsonl$/.test(n))
            .map((n) => ({ n, m: (statSafe(path.join(files.dshLogsDir, n)) || {}).mtimeMs || 0 }))
            .sort((a, b) => b.m - a.m)
        } catch {}
        /**
         * 2026-11-06 修（实测：健康检查报「发现端口 60228」而真端口是 52719，连续 2 次 warn）：
         * 旧写法「每个日志只读 512KB 尾巴、第一条命中就 break」有两个坑——
         *   ① 启动行在 10 小时日志之前，早就掉出尾巴 → 今日日志里找不到；
         *   ② 于是翻到前一天的日志，拿那种早失效的端口去探，判成 DSH 不通。
         * 现在：按日志新→旧收集端口候选（尾巴没命中就整份读），逐个真探，命中即 ok。
         */
        const candidates = []
        const collect = (text) => {
          const re = /dsh web:\s*(http:\/\/127\.0\.0\.1:(\d+))/g
          let m
          let last = null
          while ((m = re.exec(text))) last = m
          if (last) candidates.push({ url: last[1], port: Number(last[2]) || 0 })
        }
        for (const it of list) {
          const p = path.join(files.dshLogsDir, it.n)
          const before = candidates.length
          collect(readTextTail(p, 512 * 1024))
          if (candidates.length === before) collect(readTextTail(p, Infinity))
          if (candidates.length >= 3) break
        }
        const uniq = []
        for (const c of candidates) {
          if (c.port && !uniq.some((u) => u.port === c.port)) uniq.push(c)
        }
        if (!uniq.length) {
          dshMisses += 1
          const why = list.length ? `最近日志里没有 "dsh web:" 行（${list[0].n}）` : `日志目录不可读或无 desktop-next-*.jsonl：${files.dshLogsDir}`
          if (dshMisses < 2) return { ok: null, detail: `第 ${dshMisses} 次没发现到 DSH 端口（连续两次才判失败）：${why}` }
          return { ok: false, detail: `连续 ${dshMisses} 次没发现到 DSH 端口：${why}` }
        }
        let lastDetail = ''
        for (const c of uniq) {
          const r = await httpProbe(c.url, httpTimeoutMs)
          if (r.ok) {
            dshMisses = 0
            return { ok: true, detail: `发现端口 ${c.port}（候选 ${uniq.map((u) => u.port).join('/')}）；${r.detail}` }
          }
          lastDetail = `${c.port} ${r.detail}`
        }
        dshMisses += 1
        return { ok: false, detail: `候选端口全探不通（${lastDetail}）` }
      },

      /**
       * effect-queue：数 pending 且 dueAt 已过 60 秒的条数（同 id 最后一行赢，与队列自身口径一致）。
       * 文件不存在 = 队列从没启用过 → unknown，不是故障。
       */
      'effect-queue': async () => {
        const st = statSafe(files.effectQueueFile)
        if (!st || !st.isFile()) {
          return { ok: null, detail: `队列文件不存在：${files.effectQueueFile}（从未启用过，不判故障）` }
        }
        const rows = parseJsonl(readTextTail(files.effectQueueFile))
        if (!rows.length) return { ok: null, detail: '队列文件为空或没有可解析的行' }
        const last = new Map()
        for (const row of rows) {
          const id = String(row.id ?? '')
          if (!id) continue
          last.set(id, row)
        }
        const deadline = now() - EFFECT_QUEUE_STALE_MS
        let backlog = 0
        let pending = 0
        for (const row of last.values()) {
          if (String(row.status ?? '') !== 'pending') continue
          pending += 1
          const dueAt = Number(row.dueAt)
          if (Number.isFinite(dueAt) && dueAt <= deadline) backlog += 1
        }
        const detail = `${backlog} 条积压超 ${fmtDuration(EFFECT_QUEUE_STALE_MS)}（pending 共 ${pending} 条，条目 ${last.size} 个）`
        return backlog > EFFECT_QUEUE_MAX_BACKLOG ? { ok: false, detail: `${detail}，阈值 ${EFFECT_QUEUE_MAX_BACKLOG}` } : { ok: true, detail }
      },

      /** schedule-last：全库最近一次真实投递时间（lastDelivery / deliveryHistory 取最大）。只读。 */
      'schedule-last': async () => {
        const tasks = loadScheduleTaskIds()
        if (!tasks) return { ok: null, detail: `schedule.json 缺失或结构不认识：${files.scheduleFile}` }
        let newest = 0
        const push = (v) => {
          const t = Date.parse(String(v ?? ''))
          if (Number.isFinite(t) && t > newest) newest = t
        }
        for (const task of Object.values(tasks)) {
          if (!task || typeof task !== 'object') continue
          if (task.lastDelivery && typeof task.lastDelivery === 'object') push(task.lastDelivery.deliveredAt)
          if (Array.isArray(task.deliveryHistory)) for (const h of task.deliveryHistory) if (h && typeof h === 'object') push(h.deliveredAt)
        }
        if (!newest) return { ok: null, detail: `${Object.keys(tasks).length} 个定时任务里没有任何投递记录（没有可比的时间）` }
        const silence = now() - newest
        const detail = `最近投递 ${fmtDuration(silence)} 前（${new Date(newest).toISOString()}）`
        return silence > SCHEDULE_MAX_SILENCE_MS ? { ok: false, detail: `${detail}，超过 ${fmtDuration(SCHEDULE_MAX_SILENCE_MS)}` } : { ok: true, detail }
      },

      /**
       * heartbeat-seed：最近一次 seed_report 是什么时候。
       * 真相是加密账本 heartbeat-data\seed_report.jsonl（vault 加密，本探针不碰密钥）——
       * 所以优先看未加密的心跳日志里有没有明文 seed_report 事件；
       * 没有就看加密账本的 **mtime**（每次报账都会重写它，时间戳是明文事实，内容才加密）。
       * 两样都没有 → unknown。
       */
      'heartbeat-seed': async () => {
        const rows = parseJsonl(readTextTail(files.heartbeatLogFile, 1024 * 1024))
        let newest = 0
        for (const row of rows) {
          const ev = String(row.event ?? '')
          const isSeed = ev === 'seed_report' || ev === 'seed_report_ok' || (row.spoken && (row.seedIds || row.deliveryId))
          if (!isSeed) continue
          const t = Number.isFinite(Number(row.ts)) ? Number(row.ts) : Date.parse(String(row.ts ?? ''))
          if (Number.isFinite(t) && t > newest) newest = t
        }
        if (newest) {
          const silence = now() - newest
          const detail = `最近一次 seed_report ${fmtDuration(silence)} 前（心跳日志明文事件）`
          return silence > HEARTBEAT_SEED_MAX_SILENCE_MS ? { ok: false, detail: `${detail}，超过 ${fmtDuration(HEARTBEAT_SEED_MAX_SILENCE_MS)}` } : { ok: true, detail }
        }
        const ledger = statSafe(files.seedReportFile)
        if (!ledger) {
          return { ok: null, detail: `心跳日志里没有明文 seed_report，加密账本也不存在：${files.seedReportFile}（从未报过账，不判故障）` }
        }
        const silence = now() - ledger.mtimeMs
        const detail = `加密账本 mtime ${fmtDuration(silence)} 前（只读时间戳，不读密文）`
        return silence > HEARTBEAT_SEED_MAX_SILENCE_MS ? { ok: false, detail: `${detail}，超过 ${fmtDuration(HEARTBEAT_SEED_MAX_SILENCE_MS)}` } : { ok: true, detail }
      },

      /** zone-orphan：automation-zone 里登记着、但 schedule.json 里已经找不到的 scheduleId 个数。 */
      'zone-orphan': async () => {
        const zone = readJsonSafe(files.zoneStateFile)
        if (!zone) return { ok: null, detail: `automation-zone.json 缺失或结构不认识：${files.zoneStateFile}` }
        const zoneTasks = zone.tasks && typeof zone.tasks === 'object' ? zone.tasks : null
        if (!zoneTasks) return { ok: null, detail: 'automation-zone.json 里没有 tasks 段' }
        const live = loadScheduleTaskIds()
        if (!live) return { ok: null, detail: `schedule.json 不可读，无法比对孤儿：${files.scheduleFile}` }
        const orphans = Object.keys(zoneTasks).filter((id) => !Object.prototype.hasOwnProperty.call(live, id))
        const detail = orphans.length
          ? `孤儿 ${orphans.length} 个：${orphans.slice(0, 3).join('、')}${orphans.length > 3 ? ' …' : ''}`
          : `无孤儿（区里 ${Object.keys(zoneTasks).length} 个任务，日程里 ${Object.keys(live).length} 个）`
        return orphans.length > 0 ? { ok: false, detail } : { ok: true, detail }
      },
    }
    return probes
  } catch (e) {
    return unknownAll(`探针构建失败：${e && e.message ? e.message : e}`)
  }
}

// ---------------------------------------------------------------- 报告渲染

/** §6.3 的表格形状。纯函数，坏数据也不 throw。 */
export function buildReportMarkdown(ts, items) {
  try {
    const list = Array.isArray(items) ? items : []
    const lines = ['# 系统健康 · ' + fmtLocal(ts), '| 项 | 状态 | 连续失败 | 详情 |', '|---|---|---|---|']
    for (const it of list) {
      lines.push(`| ${escapeCell(it && it.name)} | ${escapeCell(it && it.status)} | ${Number(it && it.failureStreak) || 0} | ${escapeCell(it && it.detail)} |`)
    }
    const critical = list.filter((i) => i && i.status === 'critical').length
    lines.push('')
    lines.push(
      critical > 0
        ? `> 升级中：${critical} 项连续 ${CRITICAL_THRESHOLD} 次探测失败。本账只记录，不重启、不通知（提醒是 P2 看门狗的事）。`
        : '> 无升级项（连续失败满 ' + CRITICAL_THRESHOLD + ' 次才升 critical；unknown 不算失败）。',
    )
    return lines.join('\n') + '\n'
  } catch {
    return '# 系统健康 · 报告渲染失败\n'
  }
}

// ---------------------------------------------------------------- 账本

/** 从 health.jsonl 的尾部回放每项最后一次的 failureStreak（进程重启后不丢计数） */
function loadStreaks(healthFile) {
  const map = new Map()
  try {
    for (const row of parseJsonl(readTextTail(healthFile, 256 * 1024))) {
      const items = Array.isArray(row.items) ? row.items : null
      if (!items) continue
      for (const it of items) {
        if (!it || typeof it.name !== 'string') continue
        const n = Number(it.failureStreak)
        map.set(it.name, Number.isFinite(n) && n > 0 ? n : 0)
      }
    }
  } catch {}
  return map
}

export function createHealthLedger(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const dataDir =
    typeof opts.dataDir === 'string' && opts.dataDir.trim()
      ? opts.dataDir
      : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta'), 'workqueue')
  const probes = opts.probes && typeof opts.probes === 'object' ? opts.probes : {}
  const now = nowFn(opts.nowMs)
  const log = opts.log || noop
  const probeTimeoutMs = Number(opts.probeTimeoutMs) > 0 ? Number(opts.probeTimeoutMs) : DEFAULT_PROBE_TIMEOUT_MS
  const reportPath = path.join(dataDir, 'report.md')
  const healthFile = path.join(dataDir, 'health.jsonl')
  const streaks = new Map()
  let streaksLoaded = false

  function ensureStreaks() {
    if (streaksLoaded) return
    streaksLoaded = true
    try {
      for (const [k, v] of loadStreaks(healthFile)) if (!streaks.has(k)) streaks.set(k, v)
    } catch {}
  }

  /** 跑一条探针：超时与异常统一收成 unknown——「不知道」不等于「坏了」 */
  async function runProbe(fn, timeoutMs) {
    if (typeof fn !== 'function') return { verdict: null, detail: '探针未注入' }
    let timer
    try {
      const res = await Promise.race([
        Promise.resolve().then(fn),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: null, detail: `探针超时 ${timeoutMs}ms` }), timeoutMs)
          if (timer && typeof timer.unref === 'function') timer.unref()
        }),
      ])
      if (!res || typeof res !== 'object') return { verdict: null, detail: '探针返回值不是对象' }
      const detail = typeof res.detail === 'string' && res.detail ? res.detail : ''
      if (res.ok === true) return { verdict: true, detail: detail || 'ok' }
      if (res.ok === false) return { verdict: false, detail: detail || '探测失败' }
      return { verdict: null, detail: detail || 'unknown（探针没给出 ok:true / ok:false）' }
    } catch (e) {
      return { verdict: null, detail: `探针抛异常：${e && e.message ? e.message : String(e)}` }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 落盘：report.md 走 tmp+rename（避免读到半截文件），health.jsonl 只追加 */
  function persist(ts, items, critical) {
    const out = { error: '' }
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch (e) {
      out.error = `mkdir 失败：${e && e.message ? e.message : e}`
      safeLog(log, `[健康账] ${out.error}`)
      return out
    }
    try {
      const tmp = `${reportPath}.tmp`
      fs.writeFileSync(tmp, buildReportMarkdown(ts, items), 'utf8')
      fs.renameSync(tmp, reportPath)
    } catch (e) {
      out.error = `写 report.md 失败：${e && e.message ? e.message : e}`
    }
    try {
      const st = statSafe(healthFile)
      const first = !st || st.size === 0
      const line = JSON.stringify({ ts: new Date(ts).toISOString(), items, critical }) + '\n'
      fs.appendFileSync(healthFile, (first ? NDJSON_MARKER + '\n' : '') + line, 'utf8')
    } catch (e) {
      out.error = (out.error ? out.error + '；' : '') + `追加 health.jsonl 失败：${e && e.message ? e.message : e}`
    }
    if (out.error) safeLog(log, `[健康账] ${out.error}`)
    return out
  }

  /** 一次探活。永不 reject、永不 throw：最坏情况也返回一份带写入错误的 items。 */
  async function check() {
    const ts = now()
    const items = []
    try {
      ensureStreaks()
      const names = [...MONITOR_NAMES, ...Object.keys(probes).filter((n) => !MONITOR_NAMES.includes(n)).sort()]
      for (const name of names) {
        const { verdict, detail } = await runProbe(probes[name], probeTimeoutMs)
        const prev = Number(streaks.get(name)) || 0
        let status
        let failureStreak
        if (verdict === true) {
          status = 'ok'
          failureStreak = 0
        } else if (verdict === false) {
          failureStreak = prev + 1
          status = failureStreak >= CRITICAL_THRESHOLD ? 'critical' : 'warn'
        } else {
          // unknown 不算失败：清零计数，别让「测不出来」伪装成「坏了」
          status = 'unknown'
          failureStreak = 0
        }
        streaks.set(name, failureStreak)
        items.push({ name, status, failureStreak, detail })
      }
    } catch (e) {
      safeLog(log, `[健康账] 探测循环异常：${e && e.message ? e.message : e}`)
    }
    const critical = items.filter((i) => i.status === 'critical').length
    const persisted = persist(ts, items, critical)
    const out = { ok: true, ts: new Date(ts).toISOString(), items, critical, reportPath }
    if (persisted.error) out.writeError = persisted.error
    return out
  }

  return { check, paths: { dataDir, reportPath, healthFile } }
}
