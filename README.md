# TokenEconomizer for DSH

> **AI-generated code.** Every file here was written by an AI agent (a DeepSeek Harness
> session on `deepseek-flash`), directed and published by a human. Read
> [AI-DISCLOSURE.md](AI-DISCLOSURE.md) before relying on it — it records what was verified,
> what was not, and what the licence does and does not give you.

> **Not affiliated with Microsoft or UC Berkeley.** The name says what this ports, nothing
> more. [microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) is a
> separate MIT-licensed project; no code was copied from it.

A DeepSeek Harness port of the three mechanisms in
[microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer):
micro-skills, failure-loop intervention, and tool-pruning evidence.

It is **not** the upstream plugin. Upstream ships hooks for Claude Code, Codex, the
GitHub Copilot CLI, Pi and a few experimental hosts; DSH is not one of them and has no
plugin loader for another agent's hook contract. This package reimplements the mechanisms
against DSH's own extension points, so it shares the ideas and the thresholds but none of
the Python code.

## What it does

| Mechanism | In DSH |
|---|---|
| Micro-skills | A fact forms when the same normalized failure shows up in different sessions of one repository **and** a later command in the same session succeeds where the failing one did not. After `confirmSessions` (3) sessions it is injected through a scoped system-prompt section. A confirmed fact that starts failing again is dropped after `contradictionsToDrop` (2) contradictions, and one not re-confirmed for `factStaleSessions` (20) recorded sessions is still injected but marked 久未复核（可能已过期）instead of being passed off as current. |
| Loop guard | `tools/result` counts failures per signature within a turn. At `loopThreshold` (3) the agent gets one redirect through `agent.inject()`; at twice the threshold it gets a "still stuck, stop and say what blocks you" note. The turn is never interrupted. |
| Tool pruning | Every turn records which tools were loaded (`ctx.tools.definitions()`) and which were used. A tool loaded across `pruneSessions` (5) sessions and never used is reported as a proposal. **Nothing is removed automatically.** |

No mechanism calls a model. Upstream's fact proposer and stuck-turn judge are replaced by
deterministic rules, which is cheaper and needs no extra credentials but is more
conservative than upstream.

### How "the same failure" is decided

This is the question the two-minute video did not answer, so it is answered here and in
`tokeneconomizer` `{ "action": "status" }`:

1. Three regex families run first — command not found, missing module, missing file. A hit
   takes the *object name* (the command, the module, the file's basename), not the whole
   message, so the same failure reported with different paths or line numbers collapses to
   one signature.
2. Anything else falls back to a SHA-1 of the first three normalised output lines. That
   fallback **can merge two different failures**, which is why every signature the plugin has
   actually seen is listed in `status` with its hit count and session count, instead of being
   trusted silently.
3. A fact is still only a *pointer*: if a command listed as unavailable starts working again
   in a new session, the fact takes a contradiction and is dropped after two.

## Use

Ask the agent, or call the tool yourself:

- `tokeneconomizer` `{ "action": "status" }` — thresholds in effect, facts (with expiry marks), the failure signatures it has seen, and pruning evidence.
- `tokeneconomizer` `{ "action": "facts" }` — every fact with its id.
- `tokeneconomizer` `{ "action": "remember", "text": "run tests with `python -m pytest tests/`" }` — store a durable repository fact immediately.
- `tokeneconomizer` `{ "action": "forget", "id": "<id>" }` — drop one.
- `tokeneconomizer` `{ "action": "prune" }` — tools that were loaded but never used here.
- `tokeneconomizer` `{ "action": "config" }` — effective settings.

State lives in `$DSH_HOME/tokeneconomizer/repos/<repository>.json`, one file per
repository, so what it learns in one checkout never leaks into another.

## Configure

Set values in the profile patch row:

```yaml
- insert:
    - id: tokeneconomizer
      name: 'dsh-tokeneconomizer'
      config:
        loopThreshold: 4
        confirmSessions: 2
        factStaleSessions: 30
```

Every field: `enabled`, `facts`, `loopguard`, `confirmSessions`, `contradictionsToDrop`,
`maxFacts`, `maxFactsChars`, `loopThreshold`, `loopNudges`, `pruneSessions`, `stateDir`.

## Limits

- Facts need repetition across sessions; a repository new to you learns nothing for the
  first few sessions, by design.
- Only two failure shapes are recognized as facts (a command that does not exist and a
  missing module); other failures still feed the loop guard but never become facts.
- Tool pruning is advisory only. Removing tools safely needs the per-agent tool scope and
  a reversible deny list, which this port deliberately leaves out.
- No cost accounting: DSH bills through its own providers and this plugin does not price
  sessions.

## Licence

[Mozilla Public License 2.0](LICENSE). Every source file carries the Exhibit A notice, as
MPL-2.0 requires.

What that means in practice:

- You may use this in closed-source products and combine it with differently licensed code.
- If you modify any file that carries the notice, you must make that file's source available
  under MPL-2.0. New files you add stay under whatever licence you choose.
- No warranty, no patent grant beyond MPL-2.0's terms.

MPL-2.0 was chosen over MIT so that improvements to the rules — the thresholds, the
signature patterns, the fact lifecycle — stay available to whoever uses the plugin. It was
chosen over GPL so the plugin can still be bundled with proprietary hosts.

## Attribution

The mechanisms, their names, and the thresholds this port copies
(`loopguard_nudges`, `toolprune_sessions`, the three-session evidence rule) come from
[microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer) by Aaron J. Li,
Weijia Xu, Chandan Singh, Zixiao Chen, Jeevana Priya Inala, Charlotte Siska, Acar Tamersoy,
Bin Yu, Ion Stoica, Michel Galley and Jianfeng Gao (UC Berkeley, Microsoft Research,
Microsoft Security), MIT licensed. Only its published description was used; no code was
copied.

## Contributing

State AI assistance in commits (`Assisted-by: <agent or model>`). Add a check to
`test/smoke.mjs` for any rule you change — those checks are the only thing standing between
a threshold change and a silently wrong fact.
