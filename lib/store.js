/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/store.js — TokenEconomizer for DSH 的持久化层
 *
 * 状态落在 `$DSH_HOME/tokeneconomizer/`（默认 `~/.dsh/tokeneconomizer`），
 * 按仓库分文件，一个仓库一份 JSON。这样同一仓库跨会话的积累不会互相污染，
 * 也不会把别人的项目混进来。
 *
 * 写入一律「临时文件 + rename」，因为同一时刻可能有多个 Agent（主会话、
 * 子代理、并行 turn）在写同一个仓库的状态；rename 在 Windows 上是原子替换。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** 状态根目录：优先 $DSH_HOME，否则 ~/.dsh */
export function homeDir () {
  const home = process.env.DSH_HOME
  if (home && home.trim() !== '') return home
  return path.join(os.homedir(), '.dsh')
}

export function stateRoot (override) {
  if (override && override.trim() !== '') return override
  return path.join(homeDir(), 'tokeneconomizer')
}

/** 目录名里塞不下完整路径，用「可读前缀 + 短哈希」保证唯一且能一眼认出 */
export function repoKey (cwd) {
  const raw = String(cwd ?? 'unknown')
  const normalized = path.resolve(raw)
  const slug = normalized
    .replace(/^[A-Za-z]:/, (m) => m[0])
    .replace(/[\\/:]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(-80)
  const digest = crypto.createHash('sha1').update(normalized.toLowerCase()).digest('hex').slice(0, 8)
  return `${slug || 'repo'}--${digest}`
}

export function repoFile (root, cwd) {
  return path.join(root, 'repos', `${repoKey(cwd)}.json`)
}

/** 新仓库的初始状态 */
export function emptyRepo (cwd) {
  return {
    version: 1,
    repo: path.resolve(String(cwd ?? '')),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    facts: [],
    // 最近若干会话的「加载了哪些工具 / 实际用了哪些工具」，供工具裁剪提建议
    sessions: [],
    // 累计提示数（一条用户消息算一个 prompt），供 toolprune 的 p 阈值
    prompts: 0,
  }
}

export function loadRepo (root, cwd) {
  const file = repoFile(root, cwd)
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return emptyRepo(cwd)
    if (!Array.isArray(parsed.facts)) parsed.facts = []
    if (!Array.isArray(parsed.sessions)) parsed.sessions = []
    if (typeof parsed.prompts !== 'number') parsed.prompts = 0
    return parsed
  } catch {
    return emptyRepo(cwd)
  }
}

export function saveRepo (root, cwd, state) {
  const file = repoFile(root, cwd)
  const dir = path.dirname(file)
  try {
    fs.mkdirSync(dir, { recursive: true })
    state.updatedAt = Date.now()
    const payload = JSON.stringify(state, null, 2)
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
    fs.writeFileSync(tmp, payload, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * 读-改-写一次。并发的两次更新可能互相覆盖对方新增的条目，所以每次都在
 * 最新内容上改，并且只改动自己负责的那一小块。
 */
export function updateRepo (root, cwd, mutate) {
  const state = loadRepo(root, cwd)
  const next = mutate(state) ?? state
  saveRepo(root, cwd, next)
  return next
}

export function listRepos (root) {
  const dir = path.join(root, 'repos')
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
          return { file: path.join(dir, name), state: parsed }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function truncate (text, max) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}
