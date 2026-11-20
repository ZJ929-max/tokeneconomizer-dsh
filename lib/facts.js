/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/facts.js — micro-skills：跨会话记住这个仓库怎么用
 *
 * 上游 TokenEconomizer 的 micro-skills 有两条来源：模型定期审阅会话提出的
 * 事实，以及「跨会话重复出现的失败」。这里实现的是后者（上游叫 envfacts
 * 模式）：完全不调用模型，只看工具输出里**反复出现**的失败，以及之后
 * 真正让同一件事成功的那条命令。
 *
 * 一个事实长这样：
 *   `pytest` 在本仓库不可用，改用 `python -m pytest`
 *
 * 它必须满足：
 *   - 同一个失败签名在**不同会话**里出现够 confirmSessions 次（默认 3）；
 *   - 有一个后续成功的命令作为「修法」；
 * 才从 forming 变成 confirmed，开始进入系统提示。之后如果同一个失败
 * 又在新会话里重现，记一次矛盾，累计到阈值就把事实丢掉（可逆原则）。
 */

import { resultText } from './signature.js'

const MAX_SESSIONS_PER_FACT = 40

function sessionListOf (fact) {
  if (!Array.isArray(fact.sessions)) fact.sessions = []
  return fact.sessions
}

export function findFact (state, id) {
  return (state.facts ?? []).find((f) => f.id === id)
}

/**
 * 记录一次失败：新建或更新事实的 forming 状态。
 * @returns {{fact: object, isNew: boolean, contradicted: boolean}}
 */
export function touchFailure (state, sig, sessionId, failedCommand, options = {}) {
  const confirmSessions = options.confirmSessions ?? 3
  if (!Array.isArray(state.facts)) state.facts = []
  const now = Date.now()
  let fact = findFact(state, sig.id)
  let isNew = false
  let contradicted = false

  if (!fact) {
    fact = {
      id: sig.id,
      kind: sig.kind,
      subject: sig.subject,
      status: 'forming',
      fix: null,
      failedCommand: String(failedCommand ?? '').slice(0, 300),
      sessions: [],
      firstSeen: now,
      lastSeen: now,
      contradictions: 0,
    }
    state.facts.push(fact)
    isNew = true
  }

  const sessions = sessionListOf(fact)
  const seenThisSession = sessionId ? sessions.includes(sessionId) : false
  if (sessionId && !seenThisSession) {
    sessions.push(sessionId)
    if (sessions.length > MAX_SESSIONS_PER_FACT) sessions.splice(0, sessions.length - MAX_SESSIONS_PER_FACT)
  }
  fact.lastSeen = now
  if (!fact.failedCommand && failedCommand) fact.failedCommand = String(failedCommand).slice(0, 300)

  // 已经确认过的事实又失败了一次：说明它不可靠，可逆地降级
  if (fact.status === 'confirmed' && sessionId && !seenThisSession) {
    fact.contradictions = (fact.contradictions ?? 0) + 1
    contradicted = true
    if (fact.contradictions >= (options.contradictionsToDrop ?? 2)) fact.status = 'dropped'
  }

  // 证据够了就转正（只要已经有修法）
  if (fact.status === 'forming' && fact.fix && sessions.length >= confirmSessions) fact.status = 'confirmed'

  return { fact, isNew, contradicted }
}

/**
 * 一次成功调用，可能正好证实了本会话早先的一个失败。
 * 只在**同一会话**内配对，避免把「上次会话的失败」和「这次另一个命令的成功」
 * 硬凑成因果。
 *
 * @returns {string[]} 这次更新的事实说明
 */
export function applySuccess (state, toolName, command, pending, sessionId, options = {}) {
  const learned = []
  if (!pending || pending.size === 0) return learned
  const cmd = String(command ?? '')
  if (cmd.trim() === '') return learned

  for (const [id, record] of [...pending.entries()]) {
    if (record.tool !== toolName) continue
    const subject = String(record.subject ?? '')
    if (subject === '') continue

    // 修法必须提到同一个被卡住的对象，否则不算解释了这个失败
    if (!cmd.toLowerCase().includes(subject.toLowerCase())) continue
    // 原样重跑同一条命令成功，不是「换个做法」，不值得记成事实
    if (record.command && cmd.trim() === String(record.command).trim()) {
      pending.delete(id)
      continue
    }

    const fact = findFact(state, id)
    if (!fact) continue

    const fix = describeFix(record, cmd)
    const changed = fact.fix !== fix
    fact.fix = fix
    const sessions = sessionListOf(fact)
    if (sessions.length >= (options.confirmSessions ?? 3)) fact.status = 'confirmed'
    fact.lastSeen = Date.now()
    pending.delete(id)
    if (changed) learned.push(`${record.subject} → ${fix}`)
  }

  return learned
}

function describeFix (record, command) {
  const oneLine = command.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine
  if (record.kind === 'module-missing') return `先安装依赖再跑：\`${clipped}\``
  return `\`${clipped}\``
}

/** 事实的可读文本 */
export function factText (fact) {
  if (!fact) return ''
  if (fact.kind === 'manual') return String(fact.subject ?? '')
  if (fact.kind === 'module-missing') {
    return `缺少 \`${fact.subject}\`；${fact.fix ?? '需要先安装这个依赖'}`
  }
  const failed = fact.failedCommand ? `\`${shorten(fact.failedCommand, 120)}\` 不可用` : `\`${fact.subject}\` 不可用`
  if (!fact.fix) return failed
  return `${failed}，改用 ${fact.fix}`
}

function shorten (text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 从某个时间点之后，这个仓库又记录了多少个会话 */
export function sessionsSince (state, sinceTs) {
  const sessions = Array.isArray(state?.sessions) ? state.sessions : []
  let count = 0
  for (const session of sessions) {
    if (typeof session?.at === 'number' && session.at > sinceTs) count += 1
  }
  return count
}

/**
 * 事实是不是「久未复核」。
 *
 * 事实只在同一个失败重现时更新 lastSeen，所以构建命令换了、模块改名之后，
 * 旧事实会一直挂着并被当成仍然成立。这里给出一条明确的过期判据：自上次见到
 * 之后又记录了 staleSessions 个会话，就标记出来，而不是默默继续注入。
 */
export function isStale (fact, state, staleSessions = 20) {
  if (!fact) return false
  if (!Number.isFinite(staleSessions) || staleSessions <= 0) return false
  const since = typeof fact.lastSeen === 'number' ? fact.lastSeen : 0
  return sessionsSince(state, since) >= staleSessions
}

/** 一条事实是否值得进入系统提示 */
export function isInjectable (fact) {
  if (!fact || fact.status !== 'confirmed') return false
  if (fact.kind === 'manual') return typeof fact.subject === 'string' && fact.subject.trim() !== ''
  return typeof fact.fix === 'string' && fact.fix !== ''
}

/**
 * 渲染进入系统提示的那一小节。
 * 同一会话内必须稳定（每步重新拼提示词，文字变来变去会把 KV 缓存打碎），
 * 所以调用方应该在会话第一次装配时算好并缓存。
 */
export function renderFacts (state, options = {}) {
  const maxFacts = options.maxFacts ?? 12
  const maxChars = options.maxChars ?? 2000
  const staleSessions = options.staleSessions ?? 20
  const confirmed = (state.facts ?? [])
    .filter(isInjectable)
    .map((fact) => ({ fact, stale: isStale(fact, state, staleSessions) }))
    .sort((a, b) => {
      // 过期的事实沉到后面：预算不够时先保住新鲜的
      if (a.stale !== b.stale) return a.stale ? 1 : -1
      return (b.fact.sessions?.length ?? 0) - (a.fact.sessions?.length ?? 0)
    })
    .slice(0, maxFacts)

  if (confirmed.length === 0) return ''

  const lines = [
    '## Repository facts (TokenEconomizer)',
    '',
    'Learned from earlier sessions in this repository. They are cheap shortcuts, not instructions:',
    'use them when they fit, and ignore any fact a command here contradicts.',
    '',
  ]
  if (confirmed.some((entry) => entry.stale)) {
    lines.push('Facts marked 久未复核 have not been re-confirmed for many sessions here; run the command once before relying on them.')
    lines.push('')
  }
  for (const { fact, stale } of confirmed) lines.push(`- ${factText(fact)}${stale ? '（久未复核，可能已过期）' : ''}`)

  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`
  return text
}

export { resultText }
