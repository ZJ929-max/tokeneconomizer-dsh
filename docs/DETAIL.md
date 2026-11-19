# TokenEconomizer

Cuts the repeat spend of working in one repository: what an earlier session already paid
to discover is not discovered again.

This is a DeepSeek Harness port of the mechanisms in
[microsoft/TokenEconomizer](https://github.com/microsoft/TokenEconomizer). It is not the
upstream plugin: upstream targets Claude Code, Codex, the Copilot CLI and Pi through their
hook contracts, and DSH does not host another agent's plugins. The mechanisms here run on
DSH's own extension points and share none of the upstream code.

## What you get

**Learned repository facts.** When the same failure recurs across separate sessions of one
repository, and a later command in the same session succeeds where the earlier one failed,
that pair becomes a fact:

> `pytest` is unavailable, use `python -m pytest -q`

It has to be confirmed by three different sessions before it is stated. Once confirmed it
enters the system prompt at the start of each session in that repository, so the agent stops
rediscovering it. A confirmed fact that fails again in new sessions is dropped, so a bad
fact cannot stick.

**A redirect for a stuck turn.** When the same failure repeats three times inside one turn,
the agent gets one short note suggesting a different approach. If it keeps going, it gets a
note that the turn looks stuck and that stopping is the user's call. The plugin never
interrupts a turn.

**Evidence for tool pruning.** Every turn records which tools were loaded and which were
actually called. A tool loaded across five sessions in this repository and never used is
listed as a proposal. Nothing is removed: deleting a tool needs a reversible deny list and a
deliberate decision, so this port stops at the evidence.

All three run without calling a model. That is the main difference from upstream, whose fact
proposer and stuck-turn judge are model calls; those cost money and need an extra credential,
and on a repository you have not worked in much they have nothing to work from anyway.

## Using it

- `status` — what it learned here and what it is still forming.
- `facts` — the full list, with ids, so a wrong one can be dropped.
- `remember` — state a durable fact yourself, for example the build command or an
  environment variable a command needs. It applies from the next session.
- `forget` — drop one fact by id.
- `prune` — tools that were loaded but never used here.
- `config` — the settings in effect.

Facts only affect future sessions. Nothing learned mid-turn changes the current turn.

## Where it keeps what it learns

`$DSH_HOME/tokeneconomizer/repos/<repository>.json`, one file per repository. Removing the
file forgets everything about that repository. Nothing is sent anywhere.

## Limits

- A repository new to you learns nothing for its first three sessions: evidence has to
  repeat across sessions before it is trusted.
- Only an unavailable command and a missing module become facts. Other failures still count
  toward the loop guard.
- Tool pruning reports; it does not act.
- Sessions are not priced: this plugin does not estimate or report token cost.
