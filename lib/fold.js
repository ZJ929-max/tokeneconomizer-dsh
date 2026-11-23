/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/fold.js — 低频工具折叠（并入自 dsh-lazy-tools，原名 dsh-tool-fold）
 *
 * 上游 microsoft/TokenEconomizer 的 toolprune 只「提议」裁剪，决定写到设置文件里、
 * **从下一个会话开始生效**，并且 "a single use protects it for good"。DSH 这边多
 * 了一个能力：可以在会话内把工具限制住、需要时再取回。折叠就是在此基础上做的。
 *
 * 三条硬规则（都是踩出来的）：
 *  1) 限制只在**会话边界的 pre-step** 施加/更新，绝不在回合中途改工具表；
 *  2) restrict 抛错时**不拆旧限制**，下轮再试 —— 否则会出现「拆了又装」的抖动；
 *  3) 一个工具只要真被调用过就永久免折，记录跨会话保留（上游口径）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/*
 * 名字不进代码。
 *
 * 这个模块原先自带两份硬编码清单（永不折叠 / 默认折叠），里面写着别的插件的工具名。
 * 那同时违反三件事：跨插件耦合、改名即失效、以及「跨插件知识只放在整合包层」的约定。
 * 现在的口径：
 *   - 名单只来自配置（foldNames / foldKeep，见 index.js 的 settings）；
 *   - 或者来自使用证据（foldAfterSessions：连续 N 个会话都没出现调用才折），
 *     证据来自跨会话账本，不需要任何人写名字；
 *   - 本插件从不认识任何其他插件的工具名。
 */

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function schemaBytes (def) {
  try {
    return Buffer.byteLength(JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }))
  } catch {
    return 0
  }
}

function readState (file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { used: {}, seen: {} }
    return {
      ...parsed,
      used: parsed.used && typeof parsed.used === 'object' ? parsed.used : {},
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
    }
  } catch {
    return { used: {}, seen: {} }
  }
}

function writeState (file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 记账失败不能影响会话 */
  }
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

/** 逐个核对：所有被折的名字都应当看不见 */
function restrictionActive (agent, deny) {
  if (deny.length === 0) return true
  try {
    const tools = agent?.ctx?.tools
    if (!tools?.get) return true
    for (const name of deny) if (tools.get(name) !== undefined) return false
    return true
  } catch {
    return true
  }
}

/** 只接受配置里给出的名字；本模块没有任何内置工具名 */
const cleanNames = (list, keep) => (Array.isArray(list) ? list : [])
  .filter((name) => typeof name === 'string' && name !== '' && !keep.has(name))

/**
 * @param {{names?: string[], keep?: string[], afterSessions?: number, statePath: string}} options
 *   names          —— 显式折叠名单（配置给，代码没有默认值）
 *   keep           —— 豁免名单
 *   afterSessions  —— >0 时开启动态折叠：连续这么多个会话零调用的工具自动进候选
 */
export function createFolder (options = {}) {
  const statePath = String(options.statePath ?? '')
  const keep = new Set(Array.isArray(options.keep) ? options.keep : [])
  const afterSessions = Math.max(0, Number(options.afterSessions ?? 0) || 0)
  const watch = new Set(cleanNames(options.names, keep))

  const state = readState(statePath)
  const graduated = new Set([...watch].filter((name) => Number(state.used?.[name] ?? 0) > 0))
  const folded = new Set([...watch].filter((name) => !graduated.has(name)))

  /** 名字 → { desc, bytes } */
  const catalog = new Map()
  /** agent key → { agent, dispose, loaded:Set, deny:[], hooked, reinstalls, lastError } */
  const sessions = new Map()
  /** 每个会话只统计一次「这些工具出现过」 */
  const countedSessions = new Set()
  let dirty = false

  const flush = () => {
    if (!dirty) return
    dirty = false
    writeState(statePath, state)
  }

  const buildCatalog = (agent) => {
    for (const name of folded) {
      if (catalog.has(name)) continue
      try {
        const def = agent?.ctx?.tools?.get?.(name)
        if (def) catalog.set(name, { desc: clip(def.description, 90), bytes: schemaBytes(def) })
      } catch {
        /* 拿不到就跳过 */
      }
    }
  }

  function ensureRestriction (agent, { force = false } = {}) {
    const key = agent?.id ?? agent
    let rec = sessions.get(key)
    if (!rec) {
      rec = { agent, dispose: null, loaded: new Set(), deny: [], hooked: false, reinstalls: 0, lastError: null }
      sessions.set(key, rec)
    }
    rec.agent = agent
    buildCatalog(agent)

    const deny = [...catalog.keys()].filter((name) => !rec.loaded.has(name))
    if (!force && sameSet(deny, rec.deny) && restrictionActive(agent, deny)) return

    let next = null
    let failure = null
    if (deny.length > 0) {
      if (!agent?.ctx?.tools?.restrict) {
        failure = new Error('当前 scope 没有 tools.restrict，无法折叠')
      } else {
        try {
          const disposer = agent.ctx.tools.restrict({ deny })
          if (typeof disposer === 'function') next = disposer
          else failure = new Error('restrict() 没有返回解除函数')
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
      }
    }

    if (failure) {
      // 装不上就保持现状：绝不在这里 dispose，否则就是「拆了又装」
      rec.lastError = String(failure.message ?? failure).slice(0, 200)
      return
    }

    if (typeof rec.dispose === 'function') {
      try { rec.dispose() } catch { /* 旧的可能已随 agent 没了 */ }
    }
    rec.dispose = next
    rec.deny = deny
    rec.lastError = null
    rec.reinstalls += 1
  }

  /**
   * 动态折叠：只认证据，不认名字。
   * 会话第一次 pre-step 时给当前 scope 里的工具各记一次「出现」；
   * 连续 afterSessions 个会话都没被调用过、且从未被调用过的，才进入候选。
   */
  function discover (agent) {
    if (afterSessions <= 0) return
    const key = agent?.id ?? agent
    if (countedSessions.has(key)) return
    let names = []
    try {
      const definitions = agent?.ctx?.tools?.definitions?.()
      if (Array.isArray(definitions)) {
        names = definitions.map((d) => d?.name).filter((n) => typeof n === 'string' && n !== '')
      }
    } catch { names = [] }
    if (names.length === 0) return
    countedSessions.add(key)
    let changed = false
    for (const name of names) {
      if (keep.has(name)) continue
      state.seen[name] = (state.seen[name] ?? 0) + 1
      changed = true
      if (state.used[name]) continue
      if (state.seen[name] >= afterSessions && !folded.has(name)) {
        watch.add(name)
        folded.add(name)
      }
    }
    if (changed) dirty = true
  }

  function onPreStep (agent) {
    if (!agent) return
    discover(agent)
    ensureRestriction(agent)
  }

  /** 工具被真正调用：记一笔。不改当前会话的工具表（下次加载才生效） */
  function recordUse (name) {
    // 记的是「这个工具被真的调用过」，不限于已在折叠清单里的名字：
    // 动态模式下候选是后来才出现的，早先的使用必须也留证据，否则会误折。
    if (typeof name !== 'string' || name === '') return
    state.used[name] = (state.used[name] ?? 0) + 1
    if (!state.lastUsedAt || typeof state.lastUsedAt !== 'object') state.lastUsedAt = {}
    state.lastUsedAt[name] = Date.now()
    dirty = true
    if (state.used[name] === 1 || state.used[name] % 20 === 0) flush()
  }

  function load (key, name) {
    const rec = sessions.get(key)
    if (!rec) return { ok: false, reason: '还没有活动会话' }
    const target = String(name ?? '').trim()
    if (!catalog.has(target)) return { ok: false, reason: `「${target}」不在折叠清单里` }
    if (rec.loaded.has(target)) return { ok: true, already: true }
    rec.loaded.add(target)
    return { ok: true }  // 在下一次 pre-step 生效
  }

  function list (key) {
    const rec = sessions.get(key)
    const loaded = rec?.loaded ?? new Set()
    return [...catalog.entries()].filter(([name]) => !loaded.has(name))
  }

  function status (key) {
    const rec = sessions.get(key)
    const bytes = [...catalog.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    return {
      folded: catalog.size,
      watched: watch.size,
      bytes,
      tokens: Math.round(bytes / 3.2),
      loaded: rec ? rec.loaded.size : 0,
      graduated: graduated.size,
      reinstalls: rec ? rec.reinstalls : 0,
      lastError: rec?.lastError ?? null,
    }
  }

  return { onPreStep, recordUse, load, list, status, flush, folderSize: () => catalog.size }
}
