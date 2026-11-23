# Changelog

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
