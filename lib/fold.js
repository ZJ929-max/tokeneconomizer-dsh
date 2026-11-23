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

/** 这些名字无论配置怎么写都不会被折叠 */
export const NEVER_FOLD = new Set([
  'tokeneconomizer',
  'pwsh',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'read_image',
  'view_image',
  'ask_user_question',
  'todo_write',
  'present',
  'skill',
  'working_directory',
  'job_output',
  'job_kill',
  'job_list',
])

/** 默认折叠名单：低频、可替代、需要时再取回 */
export const DEFAULT_FOLD = [
  'remote_list_hosts', 'remote_list_workspaces', 'remote_create_session',
  'remote_send_message', 'remote_read_session', 'remote_interrupt_session',
  'remote_wait_sessions', 'remote_list_sessions', 'remote_upload_file',
  'remote_download_file', 'remote_get_operation',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
  'workflow', 'subagent', 'subagent_fork', 'list_agents', 'send_message',
  'wait_agent', 'list_subagent_models',
  'cu_recover', 'cu_verify', 'cu_drag', 'cu_cursor', 'cu_clipboard', 'cu_window_info',
  'bili_search', 'bili_video', 'bili_comments',
  'create_worktree', 'plugin_market', 'plugin_manager',
  'load_workspace_dependencies', 'exit_plan_mode',
  'get_goal', 'update_goal', 'create_goal',
  'cordis_inspect_list', 'cordis_inspect_query',
  'ralph', 'terminal_open', 'terminal_read', 'terminal_send', 'terminal_close',
  'terminal_list', 'terminal_signal', 'user_terminal_list', 'user_terminal_read',
]

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
    if (!parsed || typeof parsed !== 'object') return { used: {} }
    return { ...parsed, used: parsed.used && typeof parsed.used === 'object' ? parsed.used : {} }
  } catch {
    return { used: {} }
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

/**
 * @param {{names?: string[], keep?: string[], statePath: string}} options
 */
export function createFolder (options = {}) {
  const statePath = String(options.statePath ?? '')
  const keep = new Set(Array.isArray(options.keep) ? options.keep : [])
  const watch = new Set(
    (Array.isArray(options.names) && options.names.length > 0 ? options.names : DEFAULT_FOLD)
      .filter((name) => typeof name === 'string' && !NEVER_FOLD.has(name) && !keep.has(name)),
  )

  const state = readState(statePath)
  const graduated = new Set([...watch].filter((name) => Number(state.used?.[name] ?? 0) > 0))
  const folded = new Set([...watch].filter((name) => !graduated.has(name)))

  /** 名字 → { desc, bytes } */
  const catalog = new Map()
  /** agent key → { agent, dispose, loaded:Set, deny:[], hooked, reinstalls, lastError } */
  const sessions = new Map()
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

  function onPreStep (agent) {
    if (!agent) return
    ensureRestriction(agent)
  }

  /** 工具被真正调用：记一笔。不改当前会话的工具表（下次加载才生效） */
  function recordUse (name) {
    if (typeof name !== 'string' || !watch.has(name)) return
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
