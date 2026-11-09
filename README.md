# dsh-work-queue

> Persistent work-ticket state machine + system health ledger for DeepSeek Harness: tickets outlive sessions.

## 这是什么

会话是有边界的。换个会话、过一天、换一个执行器，"之前干到哪了"就断在那里——这是所有 agent
长时间作业时最先撞上的墙。`dsh-work-queue` 把这部分状态从对话里搬到磁盘上：**工单是一份磁盘上的事实，
不是某段对话里的记忆**，任何会话按 id 都能把它捞回来接着做。

它给两类使用者：一是 agent 自己（多步任务、要跨会话续做的事，用 `work_open` 开单、`work_report` 报进展、
`work_close` 收尾）；二是人（`work_list` 看欠什么、`work_watchdog` 找停滞和卡死的单）。

在 DSH 里的定位是"执行态"的那一层：工单是执行态，`pending`（待续的话）、`ledger`（承诺与事项）、
`dtodo`（带截止日期的待办）是提醒态，两者刻意不重叠。顺带它还附了一个系统健康账
（`health_check`，7 项探针），因为"这事卡住了"和"系统坏了"经常是同一个问题的两面。

## 前置条件

**这是 DeepSeek Harness Desktop 的插件，不是独立的 npm 库。** 它需要 DSH 宿主提供的 cordis `ctx`
（`tools` 服务用来注册工具，`logger` 用来打日志），没有宿主跑不起来。`node --test` 那部分测试
是纯 Node、可离线跑，但那验证的是业务逻辑，不是它作为插件的可用性。

## 安装

把仓库目录 link/junction 进 profile 的 `node_modules`，再在 `cordis.patch.yml` 里加一行：

```yaml
- insert:
    - id: work-queue
      name: 'dsh-work-queue'
      config:
        enabled: true
        dataDir: ''
```

目录示例（`<dsh-home>` 是 DSH 家目录，Windows 上形如 `C:\Users\<you>\.dsh-beta`）：

```
<dsh-home>/profiles/desktop/node_modules/dsh-work-queue  ->  <本仓库>
```

改 `cordis.patch.yml` 属于 load-once 的配置变更，**必须整 App 重启**才生效；只改源码
（`index.js` / `*.mjs`）用宿主自带的刷新机制即可。

## 配置

| 键 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `enabled` | bool | `true` | `false` 时跳过注册（工具一个都不出现，并打一行日志说明） |
| `dataDir` | string | `''` | 空串 = `<家目录>/.dsh-beta/workqueue`，换机器不用改配置 |
| `defaultRole` | string | `'lead'` | 开单时没写责任人时的默认角色名 |
| `acceptMode` | `off`/`observe`/`auto` | `'observe'` | **仅首次引导**：策略文件还不存在时用它写 `policy.json` 的 version 1；之后一律以 `policy.json` 为准 |
| `health.enabled` | bool | `true` | 健康账随包启动 |
| `health.intervalMinutes` | number | `10` | 进程内静默巡检间隔（**0 = 关**）；只在状态跃迁时唤醒 agent |
| `wakeCwd` | string | 当前工作目录 | 唤醒时投给哪个自动化会话：按这个目录去 `automation-zone.json` 的 zones 里找 sessionId |
| `watchdog.idleMs` | number | `7200000`（2h） | 停滞阈值：单开着但这么久没动 → 派生为 `idle` |
| `watchdog.waitingMs` | number | `86400000`（24h） | 等待阈值：等回话/等审阅超过这么久 → 列进 `waiting` |

## 对外能力

| 工具 | 入参要点 | 行为 |
|---|---|---|
| `work_open` | `title`（必填）、`desc`、`kind`（qq/automation/heartbeat/manual）、`priority`（p0–p2）、`role`、`sessionId`、`cwd` | 开单，同时建出这张单专属的 `work/<short>/` 目录；返回 `dir` 给中间产物用 |
| `work_report` | `id`、`outcome`（progress/ready/blocked/failed/waiting-answer/waiting-review）、`evidence`、`note`、`problemClass` | 记一次进展并派生新状态；**`ready` 不带 `evidence` 会被降级成 `blocked`**；连续 3 次 `failed` 自动变 `stuck` |
| `work_list` | `includeClosed`、`stage`、`owner`、`limit` | 列工单，已按"该先管哪个"排好序 |
| `work_get` | `id`、`events`（默认 20） | 单张全貌 + 最近事件（谁开的、报过什么、换绑过没有） |
| `work_close` | `id`、`conclusion`（必填） | 关单，**必须写结论**；不删文件，历史留着 |
| `work_attach` | `id`、`sessionId`/`cwd`/`role` | 换绑（换会话不丢单、不重置 idle 计时） |
| `work_policy` | `acceptMode`、`history` | 读/改授权档位；改动 `version+1`、写 `policy-history.jsonl`、给所有未关闭的单发一条 `policy-changed` |
| `work_watchdog` | `idleMs`、`waitingMs` | **只读**扫描：停滞 / 卡死 / 等待过久；连索引都不重建写盘 |
| `work_link_lesson` | `ticketId`、`entryId` | 把"这张单踩的坑"指到错题本的某一条（单向指认，各自写自己的文件） |
| `health_check` | 无 | 跑一次系统自检（7 项探针 + 跨轮次失败计数） |

后两个（`work_link_lesson` / `health_check`）依赖对应服务，没注入就不注册——绝不暴露一个坏工具。

## 三条硬设计（踩过才留下的，不是风格偏好）

**1. 一单一个文件。** `tickets/<id>.json` 用 tmp+rename 原子写，同一单的写走串行链；
事件流 `events.jsonl` 只追加；`index.json` 只是缓存、可以整份重建。所以一个坏文件不会拖垮整体，
也不会出现"两个真相各说各话"。

**2. `stage` 每次都从事实重新派生，绝不落盘。** 九个状态（`waiting-answer` > `waiting-review` >
`stuck` > `blocked` > `failed` > `queued` > `working` > `idle` > `closed`）是算出来的，
不是存下来的。落盘的状态早晚会和事实分叉——文件说 A、实际是 B，然后没人为这个分叉负责。
派生落在 `src/stage.mjs`：纯函数、零 IO、不读时钟（时间由调用方传入），所以能完全离线测。

**3. 报 `ready` 必须带 `evidence`，不带就自动降级成 `blocked`。**
这是本插件最核心的一条红线，也是它最有意思的设计决定。

- **为什么**：agent 说"做完了"的成本是零，验证的成本不是零。"应该没问题"和"测试 150 条全绿、
  命令输出贴在证据里"在字节上是两种不同的东西，但在语言上长得一样。只要允许 `ready` 空口报，
  这个状态机就会退化成"谁最自信谁赢"。
- **怎么做**：`work_report(outcome=ready)` 不带 `evidence` → 落库时改写成 `blocked`，并在事件流里
  留痕 `requestedOutcome: "ready"` + `downgraded: true`。**不报错、不拒绝、不假装成功**——
  它只把"未经验证的自称"如实记成"被卡住"，让下一步的人一眼看见这里缺证据。
- **代价**：写 `ready` 的人得顺手贴一条命令输出或文件路径。这正是要的代价：
  它把验证从"可选的礼貌"变成了"报完成的入账手续费"。

## 已知限制

- **不是全自动接单。** `acceptMode=auto` **尚未实现**：读到会降级为 `observe` 并在返回里标
  `downgraded`，绝不假装在自动干活。要真做，得先有完整的审计链，不能靠一个字符串放开。
- **看门狗只列不改。** `work_watchdog` 连索引都不重建；它扫完还会用 sha256 自证没碰过文件。
  看到之后要动手是**调用方**的事——只记一条提醒就收工，那是报警器不是闭环。
- **它不自己建定时任务。** 定时任务的定义属于 DSH 的 schedule 存储（load-once，手改无效），
  插件不去改它。要让看门狗周期跑，自己建一个自动化任务去调 `work_watchdog`。
- **`watchdog` 必须注入时钟**（`nowMs`）。不注入时 `ts=''`、`stalled` 恒为空——那会变成一个
  永远说"没事"的看门狗。`index.js` 里传的是 `nowMs: () => Date.now()`。
- **健康账的判据是"连续 3 次失败才算 critical"**：单次失败只是 warn，探不到（文件不存在等）算
  `unknown`，不算坏。所以看到 warn 不用慌，看到 critical 才是真连续坏了三次。
- **`idle` 的排序刻意偏离了设计文档的字面顺序**：`idle` 被提到 `queued`/`working` 之前。
  按字面顺序 `idle` 永远不可达（单还开着时 queued 或 working 必然先命中），而它恰恰是看门狗
  最该盯的一类：开着、没人动、也没人报错。
- **运行时文件不是给模型读的**：`events.jsonl` / `health-state.json` 这类是运行时状态，
  模型只该看工具返回值；把运行时状态背进上下文只会变成第二份过时事实。
- **健康探针里有几项是"本机链路"专用的**（NapCat 端口、桥接状态文件、DSH 端口）。路径可用
  `DSH_HOME` / `DSH_WORKSPACE` 覆盖，探不到一律 `unknown`，不会被误报成故障。

## 开发

```bash
node --test "test/*.test.mjs"     # 150 条断言，全部走 os.tmpdir()，不碰生产目录
```

项目结构：

```
index.js          装配：拿 tools 服务、建 store/health/policy/watchdog、注册工具
src/store.mjs     落盘：tickets 原子写、events 只追加、index 可重建、同单串行链
src/stage.mjs     stage 派生 + 排序（纯函数、零 IO、不读时钟）
src/tools.mjs     10 个模型可见工具（每个都有完整 output.schema）
src/health.mjs    健康账 7 项探针（创建时零 IO，读盘发生在探针被调用那一刻）
lib/policy.mjs    M5 授权策略（版本化 + 历史留档，全同步读改写）
lib/watchdog.mjs  看门狗只读扫描（绝无写方法调用）
lib/poller.mjs    静默巡检：只在状态跃迁时唤醒
```

业务改动一律在 `src/` 与 `lib/`；`index.js` 只做装配。测试里有断言守着「store.dataDir 必须在
tmp 内」，防止测试写坏真实工单。

## 许可

MIT。无第三方上游代码，故无 ATTRIBUTION.md。
