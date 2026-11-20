/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/ledger.js — 失败签名账本
 *
 * 「同一失败」是怎么认的，一直是这套机制里最容易被质疑的一句（评论区
 * 原话：「同一个坑如何认，片中未答」）。判据写在 signature.js 里，但如果
 * 用户看不见它匹配到了什么，判据就等于没有。
 *
 * 所以每次失败都记一笔：签名 id、命中次数、跨了几个会话。status 把它摊开，
 * 让「是不是被误合并了」变成一个可以自己去看的问题，而不是只能听作者说。
 */

/** 账本最多保留多少种签名；超出时丢最久没出现过的 */
const MAX_SIGNATURES = 60
const MAX_SESSIONS_PER_SIGNATURE = 20

/**
 * @param {object} state 仓库状态
 * @param {{id: string, kind: string, subject: string}} sig
 * @param {string|undefined} sessionId
 * @returns {object|null} 更新后的账本条目
 */
export function recordSignature (state, sig, sessionId) {
  const id = String(sig?.id ?? '').trim()
  if (id === '') return null
  if (!state.signatures || typeof state.signatures !== 'object') state.signatures = {}
  const now = Date.now()
  let entry = state.signatures[id]
  if (!entry) {
    entry = {
      id,
      kind: sig.kind,
      subject: sig.subject,
      count: 0,
      sessions: [],
      firstSeen: now,
      lastSeen: now,
    }
    state.signatures[id] = entry
  }
  entry.count = (entry.count ?? 0) + 1
  entry.lastSeen = now
  if (!Array.isArray(entry.sessions)) entry.sessions = []
  if (sessionId && !entry.sessions.includes(sessionId)) {
    entry.sessions.push(sessionId)
    if (entry.sessions.length > MAX_SESSIONS_PER_SIGNATURE) {
      entry.sessions.splice(0, entry.sessions.length - MAX_SESSIONS_PER_SIGNATURE)
    }
  }
  const ids = Object.keys(state.signatures)
  if (ids.length > MAX_SIGNATURES) {
    // 先丢「少出现」的，同类里再丢最久没出现的：高命中的签名才是真正说明了
    // 这台机器上反复踩的是什么，不能因为它出现得早而被挤掉。
    ids.sort((a, b) => {
      const diff = (state.signatures[a]?.count ?? 0) - (state.signatures[b]?.count ?? 0)
      if (diff !== 0) return diff
      return (state.signatures[a]?.lastSeen ?? 0) - (state.signatures[b]?.lastSeen ?? 0)
    })
    for (const drop of ids.slice(0, ids.length - MAX_SIGNATURES)) delete state.signatures[drop]
  }
  return entry
}

/** 命中次数最多的若干条，供 status 展示 */
export function topSignatures (state, limit = 5) {
  const all = Object.values(state.signatures ?? {})
  all.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
  return all.slice(0, Math.max(1, limit))
}

export function signatureCount (state) {
  return Object.keys(state.signatures ?? {}).length
}
