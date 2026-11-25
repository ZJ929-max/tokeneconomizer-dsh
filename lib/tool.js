/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/tool.js — `tokeneconomizer` 工具：把学到的、拦到的、建议裁掉的摊给人看
 *
 * 上游每个宿主都用斜杠命令看状态（`/tokeneconomizer:status`）。DSH 里
 * 更自然的是给 Agent 一个工具：它既能回答用户「你学到了什么」，也能
 * 让 Agent 自己把结论写进持久事实里。
 */

import { factText } from './facts.js'
import { topSignatures, signatureCount } from './ledger.js'
import { truncate } from './store.js'

const ACTIONS = ['status', 'facts', 'prune', 'remember', 'forget', 'config', 'fold', 'unfold']

export function pruneProposals (state, options = {}) {
  const minSessions = options.minSessions ?? 5
  const sessions = Array.isArray(state.sessions) ? state.sessions.slice(-Math.max(minSessions, 5)) : []
  if (sessions.length < minSessions) return []
  const recent = sessions.slice(-minSessions)

  const loadedEver = new Map()
  const usedEver = new Set()
  for (const record of recent) {
    for (const name of record.loaded ?? []) loadedEver.set(name, (loadedEver.get(name) ?? 0) + 1)
    for (const name of record.used ?? []) usedEver.add(name)
  }

  const proposals = []
  for (const [name, sessionsLoaded] of loadedEver) {
    if (usedEver.has(name)) continue
    if (sessionsLoaded < minSessions) continue
    proposals.push({ name, sessionsLoaded })
  }
  proposals.sort((a, b) => b.sessionsLoaded - a.sessionsLoaded)
  return proposals
}

function formatStatus (state, runtime, foldInfo) {
  const lines = []
  const confirmed = (state.facts ?? []).filter((f) => f.status === 'confirmed')
  const forming = (state.facts ?? []).filter((f) => f.status === 'forming')
  const dropped = (state.facts ?? []).filter((f) => f.status === 'dropped')

  lines.push(`# TokenEconomizer — ${state.repo}`)
  lines.push('')
  lines.push(`facts: ${confirmed.length} confirmed · ${forming.length} forming · ${dropped.length} dropped`)
  lines.push(`sessions recorded here: ${(state.sessions ?? []).length} · prompts seen: ${state.prompts ?? 0}`)

  // 阈值摊开写：能被复述、被改，才谈得上被信任
  const confirm = runtime.confirmSessions ?? 3
  const drop = runtime.contradictionsToDrop ?? 2
  const stale = runtime.factStaleSessions ?? 20
  const loopT = runtime.loopThreshold ?? 3
  const pruneS = runtime.pruneSessions ?? 5
  lines.push('')
  lines.push('Thresholds in effect:')
  lines.push(`- fact: confirmed after ${confirm} sessions · dropped after ${drop} contradictions · marked stale after ${stale} sessions without re-confirmation`)
  lines.push(`- loop guard: ${loopT} repeats of one signature in a turn → 1 redirect · ${loopT * 2} → one "still stuck" note · never interrupts`)
  lines.push(`- tool pruning: evidence needs ${pruneS} recorded sessions · prune still only *proposes*; what actually removes tools from the list is folding`)
  lines.push('- folding: low-frequency tools collapse to one line until you load them back; a tool that is actually called is never folded from the next session on')

  if (foldInfo) {
    lines.push('')
    lines.push(`folded tools: ${foldInfo.folded} (~${foldInfo.bytes} bytes ≈ ${foldInfo.tokens} token) · loaded back ${foldInfo.loaded} · graduated ${foldInfo.graduated} · reinstalls ${foldInfo.reinstalls}`)
    if (foldInfo.lastError) lines.push(`⚠ last fold install failed: ${foldInfo.lastError}`)
  }

  // 事实来源摊开（G4）：能看出哪条来自环境观察、哪条是人手记的
  const bySource = { envfacts: 0, proposer: 0, manual: 0 }
  for (const fact of confirmed) {
    const source = fact?.source === 'manual' ? 'manual' : fact?.source === 'proposer' ? 'proposer' : 'envfacts'
    bySource[source] += 1
  }
  lines.push(`facts by source: envfacts ${bySource.envfacts} · proposer ${bySource.proposer} · manual ${bySource.manual}`)

  const guard = state.loopguard
  if (guard && typeof guard === 'object') {
    const when = guard.lastAt ? new Date(guard.lastAt).toLocaleString() : 'never'
    lines.push(`loop guard: ${guard.nudges ?? 0} redirect(s) · ${guard.stillStuck ?? 0} still-stuck notice(s) · last ${when}`)
  }

  if (confirmed.length > 0) {
    lines.push('')
    lines.push('Confirmed (injected at session start):')
    for (const fact of confirmed.slice(0, 8)) lines.push(`- ${factText(fact)}`)
  }

  if (forming.length > 0) {
    lines.push('')
    lines.push('Still forming (shown only when confirmed by more sessions):')
    for (const fact of forming.slice(0, 6)) {
      const need = Math.max(0, confirm - (fact.sessions?.length ?? 0))
      lines.push(`- ${factText(fact)} — needs ${need} more session(s)`)
    }
  }

  const signatures = topSignatures(state, 5)
  if (signatures.length > 0) {
    lines.push('')
    lines.push(`Same-failure signatures seen here (${signatureCount(state)} kind(s) total):`)
    for (const sig of signatures) {
      lines.push(`- ${sig.id} — ${sig.count} hit(s) across ${sig.sessions?.length ?? 0} session(s)`)
    }
    lines.push('How they are judged: three regex families (command not found / module missing / file missing) take the object name first;')
    lines.push('anything else falls back to a sha1 of the first three normalised output lines. That fallback can merge two different failures,')
    lines.push('which is why the list above is shown instead of trusted silently.')
  }

  const proposals = pruneProposals(state, { minSessions: pruneS })
  if (proposals.length > 0) {
    lines.push('')
    lines.push('Tool pruning proposals (loaded but never used in recent sessions here):')
    for (const p of proposals) lines.push(`- ${p.name} — loaded in ${p.sessionsLoaded} sessions, used 0 times`)
    lines.push('Nothing is removed automatically; the list is evidence for a deliberate decision.')
    lines.push('loaded-and-unused only proves a tool was not needed *yet* — it is not proof it is never needed.')
  }

  if (confirmed.length === 0 && forming.length === 0 && proposals.length === 0) {
    lines.push('')
    lines.push('Nothing learned here yet. Facts form once the same failure shows up in three different sessions.')
  }

  return lines.join('\n')
}

function formatFacts (state) {
  const facts = state.facts ?? []
  if (facts.length === 0) return `No facts recorded for ${state.repo} yet.`
  const lines = [`# Facts — ${state.repo}`, '']
  for (const fact of facts) {
    lines.push(`- [${fact.status}] ${factText(fact)}`)
    lines.push(`  id: ${fact.id} · sessions: ${fact.sessions?.length ?? 0} · contradictions: ${fact.contradictions ?? 0}`)
  }
  return lines.join('\n')
}

export function createTool (runtime) {
  return {
    name: 'tokeneconomizer',
    description: [
      'Inspect and adjust what TokenEconomizer has learned in this repository.',
      'Use action "status" for a summary (facts, loop-guard history, tool-pruning evidence),',
      '"facts" for the full list with ids, "remember" to store a durable repository fact',
      '(build command, required env var, where generated files live), "forget" to drop one by id,',
      '"prune" for tools that were loaded but never used here, and "config" for effective settings.',
      'Facts only affect future sessions, never the current turn.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: 'What to do. Defaults to "status" when omitted.',
        },
        text: {
          type: 'string',
          description: 'For "remember": the fact to store, stated as an actionable instruction.',
        },
        id: {
          type: 'string',
          description: 'For "forget": the fact id shown by "facts".',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {},
      render (_args, value) {
        const text = value && typeof value.text === 'string' ? value.text : JSON.stringify(value)
        return [{ type: 'text', text }]
      },
    },
    async execute (args, exec) {
      const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'status'
      const cwd = runtime.cwdOf(exec?.agent)
      try {
        switch (action) {
          case 'status': {
            const key = exec?.agent?.id ?? exec?.agent
            const foldInfo = runtime.fold ? runtime.fold.status(key) : null
            return { text: formatStatus(runtime.loadRepo(cwd), runtime.settings(), foldInfo) }
          }
          case 'facts':
            return { text: formatFacts(runtime.loadRepo(cwd)) }
          case 'prune': {
            const state = runtime.loadRepo(cwd)
            const proposals = pruneProposals(state, { minSessions: runtime.settings().pruneSessions })
            if (proposals.length === 0) {
              return { text: `No pruning evidence in ${cwd} yet: need at least ${runtime.settings().pruneSessions} recorded sessions with a tool that was loaded but never used.` }
            }
            const lines = ['# Tool pruning proposals', '']
            for (const p of proposals) lines.push(`- ${p.name} — loaded in ${p.sessionsLoaded} sessions, used 0 times`)
            lines.push('', 'TokenEconomizer never removes tools by itself in this port; decide deliberately.')
            return { text: lines.join('\n') }
          }
          case 'remember': {
            const text = typeof args?.text === 'string' ? args.text.trim() : ''
            if (text === '') return { text: 'Nothing stored: "remember" needs a non-empty text.' }
            const existing = runtime.remember(cwd, text)
            return { text: existing ? `Updated: ${text}` : `Stored for future sessions in this repository: ${text}` }
          }
          case 'forget': {
            const id = typeof args?.id === 'string' ? args.id.trim() : ''
            if (id === '') return { text: 'Nothing dropped: "forget" needs an id from action "facts".' }
            const dropped = runtime.forget(cwd, id)
            return { text: dropped ? `Dropped ${id}.` : `No fact with id ${id} in this repository.` }
          }
          case 'fold': {
            if (!runtime.fold) return { text: 'Folding is disabled (config fold:false).' }
            const key = exec?.agent?.id ?? exec?.agent
            const rows = runtime.fold.list(key)
            const mode = runtime.settings().foldMode
            if (mode !== 'apply') {
              return { text: rows.length === 0
                ? 'Propose mode: no fold candidates yet.'
                : `Propose mode: ${rows.length} candidate(s) recorded in fold-proposal.json; no tool is hidden. Set foldMode: apply to let this plugin restrict the session.` }
            }
            if (rows.length === 0) return { text: 'Nothing is folded: every listed tool is already directly available.' }
            const lines = ['# Folded tools', '', 'Call tokeneconomizer { action: "unfold", name: "<tool>" } to load one back (from the next step).']
            for (const [name, entry] of rows) lines.push(`- ${name}：${entry.desc}`)
            return { text: lines.join('\n') }
          }
          case 'unfold': {
            if (!runtime.fold) return { text: 'Folding is disabled (config fold:false).' }
            if (runtime.settings().foldMode !== 'apply') return { text: 'Propose mode: nothing is folded, so there is nothing to unfold. Set foldMode: apply first.' }
            const key = exec?.agent?.id ?? exec?.agent
            const result = runtime.fold.load(key, args?.name)
            if (!result.ok) return { text: `✗ ${result.reason}` }
            if (result.already) return { text: `「${args?.name}」本会话已经取回了。` }
            return { text: `✓ 「${args?.name}」已取回，下一轮开始可直接调用。` }
          }
          case 'config': {
            const settings = runtime.settings()
            const lines = ['# Effective settings', '']
            for (const [key, value] of Object.entries(settings)) lines.push(`- ${key}: ${String(value)}`)
            return { text: lines.join('\n') }
          }
          default:
            return { text: `Unknown action "${truncate(action, 40)}". Use one of: ${ACTIONS.join(', ')}.` }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { text: `TokenEconomizer failed: ${message}` }
      }
    },
  }
}
