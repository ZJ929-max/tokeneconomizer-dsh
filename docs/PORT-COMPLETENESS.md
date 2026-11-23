# 与上游的差距、已确认缺陷、补全计划（交接文档）

> 写给**真正维护这个插件**的会话/人。读完这一份应该能直接开工，不需要再翻上游。
> 上游：<https://github.com/microsoft/TokenEconomizer>（MIT，Aaron J. Li 等，UC Berkeley / MSR）。
> 本仓库：`dsh-tokeneconomizer` 0.3.1（MPL-2.0），`C:\dev\tokeneconomizer-dsh`。
> 写这份文档的会话：`TokenEconomizer 完整迁移`（标记 3453），2026-11-23。
> 状态口径：**三套机制都在，但都是「基本版」**；下面 G/B 两组就是「残缺」的具体清单。

---

## 0. 一句话结论

现在这个移植等于上游的 **envfacts 子集 + 固定阈值 loop guard + 只读的 toolprune**：
不调用任何模型、不核算成本、不改宿主的工具设置（除了自己发明的「折叠」）、没有
设置面。要「更完整」，就是把下面 G1–G15 按 P1–P5 补上，其中只有 G5–G8、G1–G2
需要模型调用，其余都是确定性的。

---

## 1. 上游规格（照抄 README 的参数，用来对齐）

三套机制 + 一套账：

### 1.1 micro-skills（默认 **off**，因为它要调模型）
两条来源：
1. **envfacts**：跨会话重复出现的失败（零模型调用）。
2. **提议者（proposer）**：每 *k* = `microskills_propose_every`（默认 3）个会话，用一个
   模型审阅本仓库最近的会话，**提议**事实（不只是失败，还包括「必须先跑的构建步骤」
   「命令的正确拼法」「某个命令需要的环境变量」「生成物在哪」）。
生命周期：同一事实被 **3 个不同会话**证实后才在会话开始注入；后来会话**推翻**就丢弃
（可逆原则）。模式：`on` / `off` / **`envfacts`**（只学失败、零模型调用）。

### 1.2 tool pruning（默认 **on**）
- 证据口径不是「会话数」而是 **prompts 加权**：一个工具连续 *p* = `toolprune_evidence`
  （默认 10）个 prompt 未被使用、且这些 prompt 横跨至少 *m* = `toolprune_min_sessions`
  （默认 2）个会话，**或**横跨 *s* = `toolprune_sessions`（默认 5）个任意长度的会话。
- 产物是**真正的 deny list**，写进宿主自己的设置（Claude Code 的
  `.claude/settings.local.json`、Codex 的 `.codex/config.toml`、Copilot CLI 的 settings），
  从**下一个会话**起生效。
- **quiet window** *q* = `toolprune_quiet_minutes`（默认 60）：只有在仓库里闲置了这么多
  分钟之后才写 deny list（或最迟一天后写）——理由是「工具表一变，恢复的会话要重写整个
  历史到 prompt cache」。
- 模式：`on` / `off` / **`propose`**（只提议，等 `toolprune apply` 才写）。
- `toolprune restore`：把插件自己写的条目撤掉，**并让这些工具以后不再被剪**
  （"a single use protects it for good" 的另一半）。
- 插件只加自己的条目、绝不碰人手写的 deny 规则；自己创建的设置文件进 `.git/info/exclude`。

### 1.3 loop guard（默认 **on**）
- **包络（envelope）**：先学到「这个仓库里一个正常 turn 有多长」——要等到 *e* =
  `loopguard.envelope_min_samples`（默认 5）个**正常结束**的 turn 才开始介入。
- **裁判模型**：一个 turn 出现「同样的失败反复、或错误在堆积」时交给裁判，裁判给出
  「卡住了」的把握；达到 *c* = `loopguard.judge_confidence`（默认 0.7）才行动。
- **转向**：每个 turn 最多 *r* = `loopguard_nudges`（默认 1）次 redirect（一段短提示，
  进上下文，建议换做法）。
- **backstop**：turn 长度超过习惯长度的 *b* = `loopguard.backstop_mult`（默认 2.5）倍、
  且在同一批编辑/失败上打转时，**不经过裁判**直接 redirect。
- **还卡着**：redirect 用尽后，给**人**一行「怎么停」（如
  `TokenEconomizer: this turn still looks stuck after a redirect (judge-stuck@0.82, 46 tool calls). Press Esc to interrupt it.`）。
- **绝不自己中断 turn**；「在推进」的 turn 不打扰。

### 1.4 成本核算（上游的招牌指标）
- 按**实际计费**算钱：大多数 token 是缓存重读，所以价目要含 cache read / cache write 价。
- 把**插件自己的模型调用**也算进去（事实提议者 + 裁判 + redirect 文本）。
- `status` 报「这个仓库的会话花了多少」。

### 1.5 命令面（每个宿主同构）
`status` / `microskills` / `toolprune` / `toolprune restore` / `config` /
`config set <k>=<v>` / `config unset` / `repos` / `doctor`；`config set ... --global` 表示
对所有仓库生效；未加 `--global` 只对本仓库。设置还接受 `TE_<NAME>` 环境变量与
`TE_DISABLE=1`。

---

## 2. 本仓库现状（逐文件，0.3.1 实测）

| 文件 | 行数 | 现在负责 |
|---|---|---|
| `index.js` | 537 | 插件装配：配置解析、`tools/result` 观察、`session/event` 轮次、`agent/created` 记录、系统提示小节、工具注册 |
| `lib/facts.js` | 225 | 事实生命周期（forming → confirmed → dropped / stale）、注入文本渲染 |
| `lib/loopguard.js` | 106 | 固定阈值 loop guard（3 次 → 1 次 redirect；2×3 次 → still-stuck） |
| `lib/fold.js` | 260 | 折叠（并入自 `dsh-lazy-tools`）：`tools.restrict({deny})` + 跨会话使用账本 + 动态候选 |
| `lib/signature.js` | 147 | 失败判定与签名（cmd-not-found / module-missing / file-missing / sha1 兜底） |
| `lib/ledger.js` | 78 | 签名账本（命中数、会话数，上限 60） |
| `lib/store.js` | 137 | 每仓库一个 JSON 状态文件（`$DSH_HOME/tokeneconomizer/repos/`） |
| `lib/tool.js` | 240 | `tokeneconomizer` 工具：status / facts / prune / remember / forget / config / fold / unfold |
| `test/smoke.mjs` | 23 checks | 事实、签名、loop guard、prune 建议、status 文案 |
| `test/fold.mjs` | 12 checks | 折叠生命周期（restrict 语义建模） |

测试现状：`node test/smoke.mjs` 23 通过、`node test/fold.mjs` 12 通过（离线、无模型）。

**已实现、且不要回退的部分**：签名归一化、事实的 forming/confirm/contradict/stale、注入
文本按会话缓存（不抖 KV）、折叠的三条硬规则（会话边界施加 / 失败不拆旧 / 用过即免折）、
`status` 摊开阈值。

---

## 3. 差距清单（G）

### micro-skills
- **G1｜第二条来源缺失**：没有模型提议者。现在只从失败里长事实，等于上游的
  `microskills=envfacts`。→ 需要 `microskills=on` 的提议者：每 k 个会话审阅一次。
- **G2｜没有模式开关**：`facts:true/false` 是全开/全关，没有 `off` / `envfacts` / `on` 三态。
- **G3｜事实种类受限**：`index.js:329` 只接受 `cmd-not-found` 与 `module-missing`；
  `file-missing`、环境变量、生成物路径、构建顺序都不会成为事实（README「Limits」自认）。
  上游明确把这四类都列为例子里的事实。
- **G4｜提议来源未区分**：事实没有 `source` 字段（envfacts / proposer / manual），
  `status` 无法解释一条事实哪来的。

### loop guard
- **G5｜没有裁判模型**（c=0.7）。
- **G6｜没有包络学习**（e=5 个正常 turn 之前不该介入）。
- **G7｜没有 backstop**（b=2.5× 习惯长度 + 打转）。
- **G8｜「还卡着」没有对人的通道**：现在的 still-stuck 文本注入给 **agent**；上游要求
  **告诉人**怎么停（Esc / Ctrl+C / 该宿主的具体停法）。

### tool pruning / 折叠
- **G9｜证据口径是「会话数」不是「prompts 加权」**：`lib/tool.js:21` 的
  `pruneProposals` 要求最近 `pruneSessions`(=5) 个会话**每个都加载过**且从未使用；
  上游是 p=10 prompts 跨 m=2 会话，或 s=5 会话。长会话应当更重。
- **G10｜没有 quiet window（q=60）**：折叠在会话边界施加（这点比上游更好），但没有
  「最后一次活动后多久才改工具表」的概念，也没有「一天为限」的兜底。
- **G11｜restore 语义不完整**：`unfold` 只对**本会话**生效，下次会话又折回去；上游
  `restore` 是**永久免剪**。现在的「真调用过一次就毕业」在下次实例才生效（见 B3）。
- **G12｜没有 propose/apply 两档**：只有「直接折」与「只给建议」两套代码，不共享证据。
- **G13｜fold 与 prune 是两套账**：`foldAfterSessions` 的 `seen/used` 账本与
  `pruneProposals` 的 `state.sessions[].loaded/used` 是两份证据，结论可能互相矛盾。
  建议合并：**prune 决定「该剪谁」，fold 负责「怎么剪」**。

### 账与设置
- **G14｜没有成本核算**：`llm/stream` 的 `usage` 没用起来；`status` 不报 token / 缓存读写 /
  自己的调用开销。README「Limits」自认（`README.md:92`）。
- **G15｜设置面缺失**：每仓库覆盖、`config set/unset`、`TE_*` 环境变量、`repos`/`doctor`
  都没有；配置只能改 profile patch 行（要重启或 HMR）。
- **G16（可选）｜没有历史导入**：上游在 Claude Code 上能读这个仓库**更早的会话**；
  DSH 的对应物是 `~/.dsh/sessions/`（会话日志），可以在「本仓库还没有任何记录」时读一次。

---

## 4. 已确认的缺陷（B，改代码时顺手修）

- **B0｜版本号不同步**：`index.js:33` 写着 `export const version = '0.1.0'`，而
  `package.json` 是 `0.3.1`。自己报版本的地方会撒谎。
- **B1｜`noteProgress` 是死接线**：`lib/loopguard.js:89` 定义了、`test/smoke.mjs:194` 测了，
  但 `index.js` **从不调用**。模块文档说「有实质进展就清计数」，实际一条成功根本不清
  （`index.js:378-380` 的注释说这是**故意**的）。二者必须对齐：要么接上（用 turn 内成功
  工具的结果做进展判据），要么删掉函数并在 README 写明「成功不清零，只按 turn 归零」。
- **B2｜still-stuck 的判据随 `loopNudges` 漂移**：`lib/loopguard.js:75-84` 先判
  `next >= threshold && redirects < nudges`，所以 `nudges=3` 时第 6 次命中还是 redirect，
  still-stuck 要等到第 8 次 ——「两倍阈值提醒人」并不成立。判据应独立（例如「redirect 用尽
  后的下一次命中」或独立计数）。
- **B3｜「用过即免折」在下一个实例才生效**：`lib/fold.js:105` 的 `graduated` 在实例启动时
  快照；本会话里第一次调用某工具只写盘，`graduated` 不变。行为可接受，但 README 的
  字面（「一次调用即永久免折」）需要改成「下一次会话起」。
- **B4｜裁剪证据会漏记后注册的工具**：`loaded` 来自 `agent/created` 时的
  `ctx.tools.definitions()` 快照，之后动态注册的工具（MCP、subagent 工具）不在里面 →
  只会**漏报**（偏保守），可接受但要写进文档。
- **B5｜文档与行为不一致的地方统一**：`lib/tool.js:65` 仍写着「tool pruning: advice only,
  nothing is removed」，而折叠确实会移除；`lib/tool.js` 的工具 description 没提
  `fold`/`unfold` 两个 action。

---

## 5. DSH 这边能用的扩展点（已核实）

| 需要 | 扩展点 |
|---|---|
| 观察工具调用/结果 | `ctx.on('tools/result', (exec, result) => …)`（现有） |
| 观察每次模型调用与 token 用量 | **`ctx.on('llm/stream', …)` 是 waterfall**：`(options, next) => AsyncIterable<StreamChunk>`，可以包一层 next() 从 `{type:'usage', usage}` 取 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens`。`options.provider/model` 也在手边 → **成本核算 + 认出「自己的调用」都靠它** |
| 调模型（裁判 / 提议者） | `ctx.llm.stream({ provider, model, messages, system, maxTokens, signal, purpose? })`；`TokenUsage` 从流里的 `usage` chunk 读。provider/model 可先取 profile 的 `agent-default-model`，或沿用本仓库上一次 `llm/stream` 里见到的 route（更贴近上游「用你自己的 plan」） |
| 每轮开始（拿模型选择、装限制） | `ctx.on('agent/pre-step', (payload, next) => …)`，payload 里有 `{agent, messages, turn, step, signal, modelSelection}`；**折叠只能在这里改工具表**（现有约束，别动） |
| 给 agent 插话 | `agent.inject(userMessage)`（现有） |
| 给**人**说话 | 上游是宿主 UI 的一行。DSH 里可行做法：`agent.inject` 一段要求模型转述给用户的话（像上游对 Claude Code 的做法），或用 `ctx.get('user-questions')` 之外的通知面（需再确认） |
| 改工具表 | `agent.ctx.tools.restrict({ deny })` 返回解除函数；失败时**不要**拆旧限制（现有实现，遵守） |
| 系统提示注入 | `ctx.get('systemPrompt').section({name, order, text(assembleContext)})`（现有） |
| 每仓库状态 | 自己写 JSON（现有 `lib/store.js`）；不要碰 profile 共享文件 |
| 会话日志（历史导入） | `~/.dsh/sessions/<workspace>/session-*/session.v4.jsonl.zstd`（zstd 多帧，见工作区 MEMORY） |

---

## 6. 补全计划（按可交付、可测的顺序）

> 每阶段都要：更新 `CHANGELOG.md`、升 `package.json` 与 `index.js` 的 version（B0）、
> 加离线测试、跑 `node test/smoke.mjs && node test/fold.mjs` 全绿。

### P1 — 0.3.2：先对齐事实（1 个 PR 的量）
- B0、B1、B2、B5 修掉；README「Limits」改成「现在能/不能」的准确表述。
- G4：事实加 `source: 'envfacts' | 'proposer' | 'manual'`，`status` 显示来源。
- G3 的一半：把 `file-missing` 也纳入事实（它有 subject，能给出可执行建议）。
- 测试：+6（版本同步、进展判据、nudges=3 时 still-stuck 的点位、source 字段、file-missing 事实）。

### P2 — 0.4.0：把「裁剪」做成一套机制（无模型调用）
- G9/G13：合并账本 —— 一个 `evidence` 账本，按 **prompts** 记（每次 `turn/start` 记一个
  prompt；每个 prompt 记当轮用过的工具），同时记 loaded 快照。
- G11：deny 名单持久化 + `restore` 名单（永久免剪）；`unfold` 同时写进 restore。
- G12：`pruneMode: 'on' | 'propose' | 'off'`；`propose` 只出清单。
- G10：`quietMinutes`（默认 60）+「最迟一天」：只在「本仓库最后一次活动」超过 q 之后，
  于 `agent/pre-step` 施加新 deny。
- 测试：+10（prompts 加权、m/s 两档、restore 永久、propose 不施加、quiet window 时钟用注入的 now）。

### P3 — 0.4.x：成本核算（无模型调用，但要用别人的调用）
- 监听 `llm/stream`，包住 iterable 取 `usage`；按 `sessionId`/仓库/turn 记账；
  标出「本插件的调用」（用一个 AsyncLocalStorage 或 purpose 标记，避免把自己算成用户成本）。
- 价目表来自配置（`pricing: { '<provider>/<model>': { input, output, cacheRead, cacheWrite } }`，
  单位 USD / 1M tokens；**不内置任何厂商价格**）。
- `status` 加一行：token 合计 / 缓存读写 / 估算金额（没配价目就只报 token）。
- 测试：+4（usage 累计、缓存价、未配价目时的降级、自己调用的排除）。

### P4 — 0.5.0：模型调用（唯一花钱的一步；默认 **全关**）
- G5–G8：`loopguard.judge`（c=0.7）、`envelope`（e=5）、`backstop`（b=2.5×）、
  still-stuck 的「转述给人」。
- G1/G2：`microskills: 'off' | 'envfacts' | 'on'`，`proposeEvery`（k=3），提议者读
  「近期会话摘要」（失败签名、跑过的命令、修法），只提议、不确认；确认仍走 3 会话规则。
- 全部走 `ctx.llm.stream`，并且**测试用假 llm**（离线）：把判断逻辑（prompt 组装、
  置信度阈值、JSON 解析、失败降级）与真实调用分开测。
- 硬约束：模型不可用/超时/JSON 坏 → **静默降级到今天的规则版**，绝不让会话失败（上游同款）。
- 测试：+12（裁判阈值、包络未满不介入、backstop 触发、降级路径、提议者去重/合并、自己的调用计入成本）。

### P5 — 0.6.0：设置与命令面
- G15：每仓库覆盖文件（`repos/<repo>/settings.json`）叠在 profile patch 之上；
  `config set/unset`（`--global` 写全局默认）、`TE_*` 环境变量（`TE_DISABLE` 先做）、
  `repos`、`doctor`（打印状态目录、账本大小、最近错误）。
- 测试：+8。

### 可选 P6：历史导入（G16）
只在「本仓库尚无任何记录」时读一次 `~/.dsh/sessions`；默认关。

---

## 7. 约束（别踩）

1. **许可证**：MPL-2.0，新文件也要带 Exhibit A 头（见任一现有文件开头）。
   上游是 MIT，只借思路与阈值，**不要复制它的 Python 代码**（README 已声明「no code was copied」）。
2. **不硬编码别的插件的工具名**（0.3.1 的核心决定，见 `lib/fold.js` 注释）：名字只来自
   配置、证据、和用户显式 restore。折叠名单不许出现 `view_image`、`bili_*`、`cu_*` 之类。
3. **不在回合中途改工具表**：所有施加/撤销只在 `agent/pre-step`；`restrict` 失败不拆旧限制。
4. **观察者永不让会话失败**：所有监听器 try/catch，模型调用失败降级到规则版。
5. **注入文本按会话缓存**（事实小节）——每次重算会打碎 KV 缓存。
6. **测试离线**：不能联网、不能有真模型；假 `ctx` / 假 `llm` 沿用 `test/fold.mjs` 的建模方式。
7. **跨插件联动放整合包层**（工作区裁定）：插件必须能单装；要共享数据走公开工具面。
8. **发布流程**：仓库有 `PUBLISHING.md`；整合包 `plugin-pack/index.json` 的 pin 是 40 位
   commit，改完要前进 pin 并跑 `plugin-pack/scripts/check-pins.sh`（另有每 30 分钟自动
   repin 的 workflow）。改整合包范围前先在 `plugin-pack/claims/<marker>.json` 写 scope。
9. **工作区共享 Markdown 用单行 edit**，改前重读；版本/pin 不抄进文档，写「读哪个文件 + 怎么复算」。

---

## 8. 待决问题（维护者拍板）

1. **花钱的默认值**：上游 micro-skills 默认关、loop guard 默认开。建议这里**两个都默认关**，
   由用户显式开（`microskills=on` / `loopguard.judge=on`），避免升级后偷偷产生调用。
2. **provider/model 从哪来**：建议「沿用本仓库上一次真实调用的 route」，其次读 profile 的
   `agent-default-model`；两者都没有就降级为规则版。
3. **fold 与 prune 是否合并成一个机制**（我建议合并；两条证据链会互相矛盾，见 G13）。
4. **价格表**：是否复用 `@deepseek-ai/dsh-token-meter` 的价目（需要读它的 README 确认），
   还是只由用户配置。
5. **「转述给人」的实现**：上游对 Claude Code 的做法是「要求模型把这一行转述进回复」，
   模型可能改写或省略。DSH 里是否接受这个精度，还是要等一个通知面。
6. **目标版本**：这些做完是 0.6.0 还是拆成 0.3.2 / 0.4 / 0.5 / 0.6 分批发布。

---

## 9. 复现现状（给接手的人）

```powershell
# 测试（离线；sandbox 里 node 直接 spawn 会被命名管道拒，用 Start-Process 重定向）
$env:ELECTRON_RUN_AS_NODE='1'
Start-Process -FilePath $env:DSH_NODE_EXECUTABLE `
  -ArgumentList 'C:\dev\tokeneconomizer-dsh\test\smoke.mjs' `
  -WorkingDirectory 'C:\dev\tokeneconomizer-dsh' -NoNewWindow -Wait `
  -RedirectStandardOutput "$env:TEMP\te-smoke.out" -RedirectStandardError "$env:TEMP\te-smoke.err"
Get-Content "$env:TEMP\te-smoke.out"

# 当前版本与状态
git -C C:\dev\tokeneconomizer-dsh log --oneline -5
Get-Content C:\dev\tokeneconomizer-dsh\package.json | Select-String version
```
