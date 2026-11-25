# Changelog

## 0.3.3

折叠回到上游口径，并补上外部的逃生阀：

- **默认 propose**：新增 `foldMode`，默认 `propose` —— 只把候选写进 `fold-proposal.json`，**不**调用 `tools.restrict`，会话中途不动工具表。`apply` 才启用会话内限制。
- **结构性豁免**：`reserved: ['tokeneconomizer']` 写死在 `index.js`，折叠机制自己的工具永远不进候选；不再依赖部署配置的 `foldKeep`。这是 11-25 自我锁死的直接修复。
- **阈值对齐上游**：`foldAfterSessions` 默认 3 → **5**（上游 `s=5` 会话跨度）。
- **外部 restore**：新增 `scripts/fold-restore.mjs`，不经过工具，直接把 `restoreAll` 写进 `fold-state.json`；插件在该进程内不再折叠，并清掉标记。折叠工具被折掉时也能用。
- 测试：折叠自测新增 reserved / propose / restoreAll 三项。

## 0.3.2

按 `docs/PORT-COMPLETENESS.md` 的 P1 对齐事实，不新增任何模型调用：

- **版本只有一个真相**：`index.js` 的 `version` 直接读 `package.json`，不再自己写一份（原来写着 0.1.0，和 0.3.1 对不上）。
- **loop guard 的进展判据接上了**：新增 `noteSuccess()`，**同一个工具**调用成功才清它名下的失败计数；别的工具成功不清（避免「卡住的轮次里夹着成功的 read 就永不触发」）。原先 `noteProgress` 定义了却从没被调用。
- **still-stuck 不再随 `loopNudges` 漂移**：判据改成正好 `threshold×2`，与还剩几次转向无关；补了 nudges=1 与 nudges=3 两组断言。
- **`file-missing` 也进事实**：它有明确 subject，能给出可执行建议。
- **事实带来源**：`source: envfacts | proposer | manual`，`status` 按来源计数。
- **文案与行为对齐**：`prune` 仍只提议，真正移除工具的是折叠；折叠的「用过即免折」明确为「从下一次会话起」。
- 测试：smoke 23 → 28（版本同源、进展判据、nudges=3 的提醒点位、file-missing 事实）。

## 0.3.1

- **去掉代码里的工具名清单**。`lib/fold.js` 原来带两份硬编码名单（永不折叠 / 默认折叠），其中写着 `view_image`、`bili_*`、`cu_*` 等**别的插件的工具名** —— 违反低耦合、无硬编码、改名即可用，也和「跨插件互操作只允许在整合包层」的约定冲突。
- 新的口径：名字只来自三处 —— 部署配置的 `foldNames` / `foldKeep`、以及**使用证据**。新增 `foldAfterSessions`（默认 3）：连续 N 个会话零调用的工具自动进入候选，完全不依赖任何人写名字。
- 使用账本改为记录**所有**被调用过的工具（原先只记名单内的），否则动态候选会误折早就用过的工具。
- 测试：12 项折叠时序自测（新增动态候选、用过不折、keep 生效 4 项）。

## 0.3.0

- **合并**：把同作者的定位相似插件 `dsh-lazy-tools`（原名 `dsh-tool-fold`）并入本插件。原版 microsoft/TokenEconomizer 本来就有 `toolprune` 模块 —— 它只给裁剪建议、写进设置后**下一个会话才生效**，并且 "a single use protects it for good"。本插件在同样的口径上**进一步拓展了功能**：低频工具在会话开始时直接折叠成一行（`tokeneconomizer {action:"fold"}` 看清单），需要时 `{action:"unfold", name:"…"}` 取回；被真正调用过一次的工具永久免折，所有施加/撤销都只发生在会话边界，绝不在回合中途改工具表。
- 新增 `lib/fold.js`：折叠生命周期（限制装失败时不拆旧限制、load 只在下一步生效、逐个核对限制是否还在），以及跨会话的使用账本。
- 新增 `test/fold.mjs`：8 项时序自测（假 ctx，按 `dsh-tools` 的 restrict 语义建模）。
- 独立插件 `dsh-lazy-tools` 暂缓更新，功能以本插件为准。

## 0.2.0 — 2026-11-20

Three gaps that users raised under the video, fixed in code rather than in prose.

### Added
- **Facts age.** A confirmed fact is now marked 久未复核（可能已过期）once
  `factStaleSessions` (default 20) sessions have been recorded in the repository since it
  was last seen, and stale facts are sorted after fresh ones so a tight prompt budget keeps
  the current ones. A stale fact is still injected — it is labelled, not deleted.
  (`lib/facts.js`: `sessionsSince`, `isStale`; `renderFacts` gains `staleSessions`.)
- **Signature ledger.** Every failure signature actually seen is recorded with its hit count
  and session count (`lib/ledger.js`), capped at 60 entries and evicting low-count, old
  entries first. This makes "how is 'the same failure' decided" answerable from the tool
  instead of from the source.
- **`status` is explicit.** It now prints the thresholds in effect (fact confirmation, drop
  after contradictions, staleness horizon, loop-guard thresholds, pruning evidence) and the
  top signatures seen, plus the rule used to judge them.

### Changed
- `package.json` version 0.1.0 → 0.2.0.
- Pruning advice now says out loud that "loaded and unused" is not proof a tool is never
  needed.

### Tests
- `test/smoke.mjs`: 19 → 23 checks, all passing.
- One of them caught a real bug while being written: eviction used to drop the
  longest-unseen signature, which could discard a high-hit signature in favour of a
  one-off. Eviction now sorts by hit count first.

## 0.1.0 — 2026-11-19

Initial port: micro-skills facts, loop guard, tool-pruning evidence. 19 offline checks.
