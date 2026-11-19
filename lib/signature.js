/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/signature.js — 把一次工具失败压成一个可比对的「签名」
 *
 * 循环检测和事实学习都只关心「是不是同一类失败」，不关心报错文本的
 * 细微差别（路径、行号、时间戳）。所以这里把失败输出归一化成
 * `kind:subject` 形式的短标识：
 *
 *   cmd-not-found:pytest
 *   module-missing:requests
 *   file-missing:src/app.ts
 *   exit:3
 *   generic:<规范化后文本的哈希>
 */

import crypto from 'node:crypto'

/** 从工具结果里取出可读文本 */
export function resultText (result) {
  const parts = []
  const err = result?.error
  if (err && typeof err.message === 'string') parts.push(err.message)
  const content = Array.isArray(result?.content) ? result.content : []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (typeof block === 'string') parts.push(block)
  }
  if (parts.length === 0 && result && typeof result.value === 'string') parts.push(result.value)
  return parts.join('\n')
}

/** 工具调用的命令文本（bash / pwsh 这类执行类工具才有） */
export function commandOf (args) {
  if (!args || typeof args !== 'object') return ''
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof args[key] === 'string' && args[key].trim() !== '') return args[key]
  }
  return ''
}

const CMD_NOT_FOUND = [
  /The term '([^']+)' is not recognized/i,
  /无法将[“‘"']?([^”’"'，,\s]+)[”’"']?项识别为/i,
  /'([^']+)' is not recognized as an internal or external command/i,
  /(?:^|\n)\s*([^\s:]+): command not found/i,
  /(?:^|\n)\s*([^\s:]+): (?:未找到命令|找不到命令)/i,
]

const MODULE_MISSING = [
  /Cannot find module '([^']+)'/i,
  /No module named '?([A-Za-z0-9_.-]+)'?/i,
  /Cannot find package '([^']+)'/i,
]

const FILE_MISSING = [
  /ENOENT[^\n]*?['"]([^'"]+)['"]/i,
  /No such file or directory:?\s*['"]?([^\s'"]+)['"]?/i,
  /(?:无法找到路径|cannot find path)[^\n]*?['"]([^'"]+)['"]/i,
]

function firstMatch (patterns, text) {
  for (const pattern of patterns) {
    const m = pattern.exec(text)
    if (m) return m[1]
  }
  return null
}

/** 去掉路径前缀，只留可识别的末段 */
function tailOf (value) {
  const s = String(value ?? '').trim()
  if (s === '') return ''
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : s
}

function normalize (text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 3)
    .join(' ')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, 160)
}

/**
 * @param {string} toolName
 * @param {unknown} args
 * @param {string} text  失败输出
 * @returns {{id: string, kind: string, subject: string, command: string}}
 */
export function signatureOf (toolName, args, text) {
  const body = String(text ?? '')
  const command = commandOf(args)

  const cmd = firstMatch(CMD_NOT_FOUND, body)
  if (cmd) {
    const subject = cmd.trim()
    return { id: `cmd-not-found:${subject.toLowerCase()}`, kind: 'cmd-not-found', subject, command }
  }

  const mod = firstMatch(MODULE_MISSING, body)
  if (mod) {
    const subject = mod.trim()
    return { id: `module-missing:${subject.toLowerCase()}`, kind: 'module-missing', subject, command }
  }

  const file = firstMatch(FILE_MISSING, body)
  if (file) {
    const subject = tailOf(file)
    return { id: `file-missing:${subject.toLowerCase()}`, kind: 'file-missing', subject, command }
  }

  // PowerShell 里非终止错误也常以纯 stderr 文本出现；退化为「工具+首段文本」哈希
  const normalized = normalize(body)
  const digest = crypto.createHash('sha1').update(`${toolName}\n${normalized}`).digest('hex').slice(0, 12)
  return { id: `generic:${digest}`, kind: 'generic', subject: normalized.slice(0, 80), command }
}

/**
 * 一次调用是否算失败。
 *
 * 注意：DSH 的 shell 工具对**非零退出码不抛错**，而是把 `[exit code: N]`
 * 写进结果文本里（`isError` 仍是 false）。只看 `isError` 会让绝大多数
 * 真实的构建/测试失败漏过去，所以这里把退出码标记也认作失败。
 */
export function isFailure (result, text) {
  if (!result) return false
  if (result.isError === true) return true
  // 有的执行类工具不抛错，而是把退出码写进 meta
  const meta = result.meta
  if (meta && typeof meta === 'object' && typeof meta.exitCode === 'number' && meta.exitCode !== 0) return true
  const body = typeof text === 'string' && text !== '' ? text : resultText(result)
  const marker = /\[exit code:\s*(-?\d+)\]/i.exec(body)
  if (marker && Number(marker[1]) !== 0) return true
  return false
}
