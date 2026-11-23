/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * dsh-tokeneconomizer — TokenEconomizer 的 DSH 原生移植
 *
 * 上游（microsoft/TokenEconomizer）是给 Claude Code / Codex / Copilot CLI / Pi
 * 写的插件，靠各家的 hook 契约读会话、改设置。DSH 不在支持列表里，所以这里
 * **不复用它的 Python 代码**，而是把它的三套机制接到 DSH 自己的扩展点上：
 *
 *   micro-skills   → `ctx.systemPrompt.section()` + 按仓库持久化的事实
 *   loop guard     → `tools/result` 观察失败 + `agent.inject()` 插一句转向
 *   tool pruning   → `tools/result` 与 `ctx.tools.definitions()` 的加载/使用对比
 *
 * 全部机制都不调用模型：事实只从「跨会话重复出现的失败」里长出来，
 * 卡死判断用确定的阈值而不是裁判模型。代价是它比上游保守，也更便宜。
 */

import path from 'node:path'

import { loadRepo, saveRepo, stateRoot } from './lib/store.js'
import { resultText, commandOf, signatureOf, isFailure } from './lib/signature.js'
import { touchFailure, applySuccess, renderFacts } from './lib/facts.js'
import { recordSignature } from './lib/ledger.js'
import { LoopGuard } from './lib/loopguard.js'
import { createFolder } from './lib/fold.js'
import { createTool } from './lib/tool.js'

export const name = 'dsh-tokeneconomizer'
export const version = '0.1.0'

/** 没有工具服务就没法观察调用，插件也没有存在的意义 */
export const inject = ['tools']

const DEFAULT_SETTINGS = {
  enabled: true,
  facts: true,
  loopguard: true,
  confirmSessions: 3,
  contradictionsToDrop: 2,
  maxFacts: 12,
  maxFactsChars: 2000,
  factStaleSessions: 20,
  loopThreshold: 3,
  loopNudges: 1,
  pruneSessions: 5,
  fold: true,
  foldNames: [],
  foldKeep: [],
  foldAfterSessions: 3,
  stateDir: '',
}

/* ------------------------------------------------------------------ *
 * Config：Schemastery 能 import 就用它，否则导出 undefined 走降级路径。
 * 顶层静态 import 会在官方包不可解析时让整个插件在链接阶段炸掉，所以用
 * 动态 import + catch（同一个 profile 里 dsh-tools 的 peer 依赖就常缺席）。
 * ------------------------------------------------------------------ */
let Schema = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  const candidate = mod?.default ?? mod
  if (candidate && typeof candidate.object === 'function') Schema = candidate
} catch {
  Schema = null
}

/**
 * 官方包能 import 但版本残缺（缺 natural() 之类）时，`Schema.object(...)`
 * 会在**模块求值期**抛错，那比「拿不到包」更糟：整行插件直接加载失败。
 * 所以构建也包一层，失败就退回无 schema —— apply() 里每个字段都有默认值兜底。
 */
function buildConfig (schema) {
  if (!schema) return undefined
  try {
    return schema.object({
      enabled: schema.boolean().description('总开关').default(true),
      facts: schema.boolean().description('把学到的仓库事实注入系统提示（micro-skills）').default(true),
      loopguard: schema.boolean().description('同一轮反复失败时插入一次转向提示（loop guard）').default(true),
      confirmSessions: schema.natural().description('一个事实要被多少个不同会话证实才算数').default(3),
      contradictionsToDrop: schema.natural().description('已确认的事实被推翻几次后丢弃').default(2),
      maxFacts: schema.natural().description('最多注入几条事实').default(12),
      maxFactsChars: schema.natural().description('注入事实的字符预算').default(2000),
      factStaleSessions: schema.natural().description('事实自上次见到后经过多少个会话就标记为可能过期').default(20),
      loopThreshold: schema.natural().description('同一失败在同一轮出现几次才介入').default(3),
      loopNudges: schema.natural().description('每轮最多转向几次').default(1),
      pruneSessions: schema.natural().description('工具裁剪建议需要多少个会话的证据').default(5),
      fold: schema.boolean().description('把低频工具折叠成一行名字（并入自 dsh-lazy-tools）').default(true),
      foldNames: schema.array(schema.string()).description('显式折叠名单；本插件不含任何内置工具名，跨插件的取舍写在部署配置里').default([]),
      foldKeep: schema.array(schema.string()).description('从折叠名单里豁免的名字').default([]),
      foldAfterSessions: schema.natural().description('动态折叠：连续这么多个会话零调用的工具自动进入候选；0 关闭').default(3),
      stateDir: schema.string().description('状态目录，留空用 $DSH_HOME/tokeneconomizer').default(''),
    })
  } catch {
    return undefined
  }
}

export const Config = buildConfig(Schema)

/** 注入用的 UserMessage 工厂（官方包不可解析时用等价字面量） */
let createUserMessage = null
try {
  const mod = await import('@deepseek-ai/dsh-llm')
  const candidate = mod?.createUserMessage ?? mod?.default?.createUserMessage
  if (typeof candidate === 'function') createUserMessage = candidate
} catch {
  createUserMessage = null
}

function buildContextMessage (text) {
  const content = [{ type: 'text', text }]
  if (createUserMessage) {
    try {
      return createUserMessage({ content, source: { kind: 'user' } })
    } catch {
      // 落到字面量
    }
  }
  return {
    id: `te-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content,
    source: { kind: 'user' },
  }
}

function asBool (value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    try { return asBool(value.get(), fallback) } catch { return fallback }
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return !['false', '0', 'off', 'no', ''].includes(value.toLowerCase())
  return Boolean(value)
}

function asNumber (value, fallback, min = 0) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    try { return asNumber(value.get(), fallback, min) } catch { return fallback }
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < min) return fallback
  return Math.floor(n)
}

function resolveSettings (config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    enabled: asBool(c.enabled, DEFAULT_SETTINGS.enabled),
    facts: asBool(c.facts, DEFAULT_SETTINGS.facts),
    loopguard: asBool(c.loopguard, DEFAULT_SETTINGS.loopguard),
    confirmSessions: asNumber(c.confirmSessions, DEFAULT_SETTINGS.confirmSessions, 1),
    contradictionsToDrop: asNumber(c.contradictionsToDrop, DEFAULT_SETTINGS.contradictionsToDrop, 1),
    maxFacts: asNumber(c.maxFacts, DEFAULT_SETTINGS.maxFacts, 1),
    maxFactsChars: asNumber(c.maxFactsChars, DEFAULT_SETTINGS.maxFactsChars, 200),
    factStaleSessions: asNumber(c.factStaleSessions, DEFAULT_SETTINGS.factStaleSessions, 1),
    loopThreshold: asNumber(c.loopThreshold, DEFAULT_SETTINGS.loopThreshold, 2),
    loopNudges: asNumber(c.loopNudges, DEFAULT_SETTINGS.loopNudges, 1),
    pruneSessions: asNumber(c.pruneSessions, DEFAULT_SETTINGS.pruneSessions, 2),
    fold: asBool(c.fold, DEFAULT_SETTINGS.fold),
    foldNames: Array.isArray(c.foldNames) ? c.foldNames.filter((n) => typeof n === 'string') : DEFAULT_SETTINGS.foldNames,
    foldKeep: Array.isArray(c.foldKeep) ? c.foldKeep.filter((n) => typeof n === 'string') : DEFAULT_SETTINGS.foldKeep,
    foldAfterSessions: asNumber(c.foldAfterSessions, DEFAULT_SETTINGS.foldAfterSessions, 0),
    stateDir: typeof c.stateDir === 'string' ? c.stateDir : DEFAULT_SETTINGS.stateDir,
  }
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */
export function apply (ctx, config) {
  const settings = resolveSettings(config)
  if (!settings.enabled) return

  const root = stateRoot(settings.stateDir)
  const loopGuard = new LoopGuard({ threshold: settings.loopThreshold, nudges: settings.loopNudges })
  /**
   * 折叠（并入自 dsh-lazy-tools）：与 micro-skills / loop guard 并列的第三套机制。
   * 只在会话边界的 pre-step 施加，回合中途绝不改工具表。
   */
  const folder = settings.fold
    ? createFolder({
        names: settings.foldNames,
        keep: settings.foldKeep,
        afterSessions: settings.foldAfterSessions,
        statePath: path.join(root, 'fold-state.json'),
      })
    : null

  /** cwd → 仓库状态（内存副本，落盘在 turn 结束时统一做） */
  const repoStates = new Map()
  /** sessionId → { turn } */
  const sessionMeta = new Map()
  /** sessionId → Map<signatureId, {tool, kind, subject, command}> 本会话尚未被解释的失败 */
  const pendingFailures = new Map()
  /** sessionId → 已算好的注入文本（同一会话内稳定） */
  const factsCache = new Map()
  /** sessionId → { cwd, loaded:Set, used:Set } */
  const sessionRecords = new Map()

  /**
   * 内存状态的键必须和落盘文件名用同一套归一化：`repoKey` 会把路径转小写，
   * 如果这里按原样字符串做键，`C:\Repo` 和 `c:\repo` 就会各拿一份内存副本
   * 去写同一个文件，后写的把先写的更新丢掉（实测踩过：forget 掉的条目复活）。
   */
  function cacheKey (cwd) {
    try {
      return path.resolve(String(cwd)).toLowerCase()
    } catch {
      return String(cwd).toLowerCase()
    }
  }

  function stateOf (cwd) {
    const key = cacheKey(cwd)
    let state = repoStates.get(key)
    if (!state) {
      state = loadRepo(root, cwd)
      repoStates.set(key, state)
    }
    return state
  }

  function flush (cwd) {
    try {
      if (cwd) saveRepo(root, cwd, stateOf(cwd))
    } catch {
      // 落盘失败不影响会话
    }
  }

  /**
   * 先落盘，再从磁盘读最新内容改，改完写回并把这份作为新的缓存。
   * 这样「观察期攒在内存里还没落盘的失败」不会被一次 remember/forget 覆盖掉。
   */
  function mutateRepo (cwd, fn) {
    flush(cwd)
    const state = loadRepo(root, cwd)
    const result = fn(state)
    saveRepo(root, cwd, state)
    repoStates.set(cacheKey(cwd), state)
    return result
  }

  function flushAll () {
    for (const state of repoStates.values()) {
      try {
        saveRepo(root, state.repo, state)
      } catch { /* 忽略 */ }
    }
  }

  function cwdOf (agent) {
    if (!agent) return undefined
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && typeof wd.get === 'function' && agent.session) {
        const dir = wd.get(agent.session)
        if (typeof dir === 'string' && dir !== '') return dir
      }
    } catch {
      // 服务缺席时退回会话头
    }
    try {
      const headerCwd = agent.session?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
      const direct = agent.session?.cwd
      if (typeof direct === 'string' && direct !== '') return direct
    } catch {
      // 忽略
    }
    return undefined
  }

  function sessionKeyOf (agent) {
    return agent && agent.id ? String(agent.id) : undefined
  }

  function factsTextFor (agent) {
    if (!settings.facts) return ''
    const key = sessionKeyOf(agent)
    if (key && factsCache.has(key)) return factsCache.get(key)
    const cwd = cwdOf(agent)
    let text = ''
    if (cwd) {
      try {
        text = renderFacts(stateOf(cwd), {
          maxFacts: settings.maxFacts,
          maxChars: settings.maxFactsChars,
          staleSessions: settings.factStaleSessions,
        })
      } catch {
        text = ''
      }
    }
    if (key) factsCache.set(key, text)
    return text
  }

  /* ---------------- tools/result：事实学习 + 循环检测 ---------------- */
  function onToolResult (exec, result) {
    try {
      const agent = exec?.agent
      const key = sessionKeyOf(agent)
      if (!key) return
      const cwd = cwdOf(agent)
      if (!cwd) return

      const toolName = typeof exec?.name === 'string' ? exec.name : 'unknown'
      const record = sessionRecords.get(key)
      if (record) record.used.add(toolName)
      try { folder?.recordUse(toolName) } catch { /* 忽略 */ }

      if (isFailure(result, text)) {
        const sig = signatureOf(toolName, exec?.arguments, text)
        const command = commandOf(exec?.arguments)

        // 先把这笔记进账本：判据的命中结果必须可查，不能只存在于代码里
        try { recordSignature(stateOf(cwd), sig, key) } catch { /* 忽略 */ }

        // 事实只从两种「环境类」失败里长：某条命令根本不存在，或缺某个模块。
        // 其它失败（缺文件、随便一条报错）仍喂给 loop guard，但截断的报错文本
        // 不是一条可执行的建议，记成事实只会污染注入。
        const factKinds = sig.kind === 'cmd-not-found' || sig.kind === 'module-missing'
        if (settings.facts && factKinds) {
          let pending = pendingFailures.get(key)
          if (!pending) { pending = new Map(); pendingFailures.set(key, pending) }
          if (!pending.has(sig.id)) {
            pending.set(sig.id, { tool: toolName, kind: sig.kind, subject: sig.subject, command })
          }
          try {
            touchFailure(stateOf(cwd), sig, key, command, {
              confirmSessions: settings.confirmSessions,
              contradictionsToDrop: settings.contradictionsToDrop,
            })
          } catch { /* 忽略 */ }
        }

        if (settings.loopguard) {
          const turn = sessionMeta.get(key)?.turn ?? 0
          const outcome = loopGuard.noteFailure(key, turn, sig)
          const note = outcome.redirect ?? outcome.stillStuck
          if (note) {
            try {
              agent.inject(buildContextMessage(note))
            } catch {
              // 注入失败就放弃：观察者绝不能让工具调用失败
            }
            try {
              const state = stateOf(cwd)
              if (!state.loopguard || typeof state.loopguard !== 'object') {
                state.loopguard = { nudges: 0, stillStuck: 0, lastAt: 0 }
              }
              if (outcome.redirect) state.loopguard.nudges += 1
              if (outcome.stillStuck) state.loopguard.stillStuck += 1
              state.loopguard.lastAt = Date.now()
            } catch { /* 忽略 */ }
          }
        }
        return
      }

      // 成功：可能是某个失败的修法
      if (settings.facts) {
        const pending = pendingFailures.get(key)
        const command = commandOf(exec?.arguments)
        if (pending && pending.size > 0 && command !== '') {
          try {
            applySuccess(stateOf(cwd), toolName, command, pending, key, { confirmSessions: settings.confirmSessions })
          } catch { /* 忽略 */ }
        }
      }
      // 成功后**不清循环计数**：一个卡住的 turn 里往往夹着成功的 read / grep，
      // 任何成功都清零会让「同一轮反复撞同一面墙」几乎永远触发不了。
      // 计数只按 turn 归零（session/event 的 turn/start），每轮最多转向一次。
    } catch {
      // 观察者永远不能让工具调用失败
    }
  }

  /* ---------------- session/event：轮次与落盘 ---------------- */
  function onSessionEvent (session, event) {
    try {
      const type = String(event?.type ?? '')
      const sessionId = String(session?.id ?? '')
      if (sessionId === '') return

      if (type === 'turn/start') {
        const previous = sessionMeta.get(sessionId)?.turn ?? 0
        const turn = typeof event?.turn === 'number' ? event.turn : previous + 1
        sessionMeta.set(sessionId, { turn })
        loopGuard.startTurn(sessionId, turn)
        const record = sessionRecords.get(sessionId)
        if (record) {
          stateOf(record.cwd).prompts = (stateOf(record.cwd).prompts ?? 0) + 1
        }
        return
      }

      if (type === 'turn/end') {
        const record = sessionRecords.get(sessionId)
        if (!record) return
        try {
          const state = stateOf(record.cwd)
          if (!Array.isArray(state.sessions)) state.sessions = []
          const entry = { id: sessionId, at: Date.now(), loaded: [...record.loaded], used: [...record.used] }
          const index = state.sessions.findIndex((s) => s?.id === sessionId)
          if (index >= 0) state.sessions[index] = entry
          else state.sessions.push(entry)
          if (state.sessions.length > 30) state.sessions.splice(0, state.sessions.length - 30)
        } catch { /* 忽略 */ }
        flush(record.cwd)
      }
    } catch {
      // 忽略
    }
  }

  function onAgentCreated (payload) {
    try {
      const agent = payload?.agent
      const key = sessionKeyOf(agent)
      if (!key) return
      const cwd = cwdOf(agent)
      sessionMeta.set(key, { turn: 0 })
      factsCache.delete(key)
      if (!cwd) return
      // 先算一次，保证本会话第一次装配就带上事实
      factsTextFor(agent)
      let loaded = []
      try {
        const definitions = ctx.tools?.definitions?.()
        if (Array.isArray(definitions)) {
          loaded = definitions.map((d) => (typeof d?.name === 'string' ? d.name : '')).filter((n) => n !== '')
        }
      } catch {
        loaded = []
      }
      sessionRecords.set(key, { cwd, loaded: new Set(loaded), used: new Set() })
    } catch {
      // 忽略
    }
  }

  function onAgentDisposed (payload) {
    try {
      const key = sessionKeyOf(payload?.agent)
      if (!key) return
      const record = sessionRecords.get(key)
      loopGuard.forget(key)
      sessionMeta.delete(key)
      pendingFailures.delete(key)
      factsCache.delete(key)
      sessionRecords.delete(key)
      if (record) flush(record.cwd)
    } catch {
      // 忽略
    }
  }

  /* ---------------- 注册 ---------------- */
  ctx.on('tools/result', onToolResult)
  // 折叠：只认「真的被调用过」，且只在下一步生效
  ctx.on('agent/pre-step', (payload, next) => {
    try { folder?.onPreStep(payload?.agent) } catch { /* 观察者不能让这一步失败 */ }
    return next()
  })
  ctx.effect(() => () => { try { folder?.flush() } catch { /* 忽略 */ } })
  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/created', onAgentCreated)
  ctx.on('agent/disposed', onAgentDisposed)
  ctx.effect(() => () => flushAll())

  // micro-skills：事实以系统提示小节的形式进入每个会话。
  // 全局注册一次即可 —— 装配上下文里带着 agent，按它的 cwd 取本仓库的事实。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({
      name: 'tokeneconomizer-facts',
      order: 860,
      text: (assembleContext) => {
        try {
          return factsTextFor(assembleContext?.agent)
        } catch {
          return ''
        }
      },
    }))
  }

  // 工具：给人看的入口，也让 Agent 自己记录仓库事实
  const runtime = {
    settings: () => settings,
    loadRepo: (cwd) => stateOf(cwd ?? '.'),
    cwdOf,
    confirmSessions: settings.confirmSessions,
    pruneSessions: settings.pruneSessions,
    fold: folder,
    remember (cwd, text) {
      return mutateRepo(cwd, (state) => {
        const existing = state.facts.find((f) => f.kind === 'manual' && f.subject === text)
        if (existing) {
          existing.lastSeen = Date.now()
          return true
        }
        state.facts.push({
          id: `manual:${Date.now().toString(36)}`,
          kind: 'manual',
          subject: text,
          status: 'confirmed',
          fix: null,
          failedCommand: '',
          sessions: ['manual'],
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          contradictions: 0,
        })
        return false
      })
    },
    forget (cwd, id) {
      return mutateRepo(cwd, (state) => {
        const index = state.facts.findIndex((f) => f.id === id)
        if (index < 0) return false
        state.facts.splice(index, 1)
        return true
      })
    },
  }

  ctx.effect(() => ctx.tools.register(createTool(runtime)))
}
