/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * test/smoke.mjs — 不依赖 DSH 运行时的逻辑自测
 *
 * 覆盖三件容易出错的事：失败签名的归一化、事实的三会话转正与推翻、
 * 以及循环检测的阈值与每轮重置。跑法：
 *   ELECTRON_RUN_AS_NODE=1 <node> test/smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { stateRoot, repoKey, loadRepo, saveRepo, emptyRepo } from '../lib/store.js'
import { signatureOf, isFailure, resultText } from '../lib/signature.js'
import { touchFailure, applySuccess, renderFacts, factText, isStale, sessionsSince } from '../lib/facts.js'
import { recordSignature, topSignatures, signatureCount } from '../lib/ledger.js'
import { LoopGuard } from '../lib/loopguard.js'
import { pruneProposals, createTool } from '../lib/tool.js'

let passed = 0
function check (label, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'te-smoke-'))
const cwd = path.join(tmp, 'repo')
fs.mkdirSync(cwd, { recursive: true })

/* ---------------- 签名 ---------------- */
check('PowerShell 命令不存在 → cmd-not-found', () => {
  const sig = signatureOf('pwsh', { command: 'pytest -q' },
    "The term 'pytest' is not recognized as a name of a cmdlet, function, script file, or executable program.")
  assert.equal(sig.kind, 'cmd-not-found')
  assert.equal(sig.subject.toLowerCase(), 'pytest')
  assert.equal(sig.id, 'cmd-not-found:pytest')
})

check('中文 cmdlet 报错也能认', () => {
  const sig = signatureOf('pwsh', { command: 'pytest' },
    '无法将“pytest”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。')
  assert.equal(sig.kind, 'cmd-not-found')
  assert.equal(sig.subject, 'pytest')
})

check('缺模块 → module-missing', () => {
  const sig = signatureOf('pwsh', { command: 'python x.py' }, 'ModuleNotFoundError: No module named \'requests\'')
  assert.equal(sig.kind, 'module-missing')
  assert.equal(sig.subject, 'requests')
})

check('缺失文件只保留末段', () => {
  const sig = signatureOf('read', { path: 'src/app.ts' }, "Error: ENOENT: no such file or directory, open 'C:\\repo\\src\\app.ts'")
  assert.equal(sig.kind, 'file-missing')
  assert.equal(sig.subject, 'app.ts')
})

check('退出码非零算失败', () => {
  assert.equal(isFailure({ isError: true, content: [] }), true)
  assert.equal(isFailure({ isError: false, content: [], meta: { exitCode: 2 } }), true)
  assert.equal(isFailure({ isError: false, content: [] }), false)
})

check('shell 的 [exit code: N] 标记也算失败（shell 工具不抛错）', () => {
  assert.equal(isFailure({ isError: false, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] }), true)
  assert.equal(isFailure({ isError: false, content: [{ type: 'text', text: '[exit code: 0] all good' }] }), false)
  assert.equal(isFailure({ isError: false, content: [] }, '[exit code: 3]'), true)
})

check('结果文本包含 error.message 与内容块', () => {
  const text = resultText({ isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: 'detail' }] })
  assert.match(text, /boom/)
  assert.match(text, /detail/)
})

/* ---------------- 事实：三会话转正 ---------------- */
check('同一失败在三个会话后转正并渲染', () => {
  const root = stateRoot(path.join(tmp, 'state'))
  const state = emptyRepo(cwd)
  const sig = signatureOf('pwsh', { command: 'pytest -q' }, "The term 'pytest' is not recognized as a name of a cmdlet")
  const confirmSessions = 3

  for (const sessionId of ['s1', 's2', 's3']) {
    touchFailure(state, sig, sessionId, 'pytest -q', { confirmSessions })
    const pending = new Map([[sig.id, { tool: 'pwsh', kind: sig.kind, subject: sig.subject, command: 'pytest -q' }]])
    applySuccess(state, 'pwsh', 'python -m pytest -q', pending, sessionId, { confirmSessions })
  }

  const fact = state.facts.find((f) => f.id === sig.id)
  assert.equal(fact.status, 'confirmed')
  assert.equal(fact.sessions.length, 3)

  const text = renderFacts(state, {})
  assert.match(text, /Repository facts/)
  assert.match(text, /python -m pytest -q/)

  saveRepo(root, cwd, state)
  const reloaded = loadRepo(root, cwd)
  assert.equal(reloaded.facts[0].status, 'confirmed')
})

check('只在一个会话里重复不算数', () => {
  const state = emptyRepo(cwd)
  const sig = signatureOf('pwsh', { command: 'pytest' }, "The term 'pytest' is not recognized as a name of a cmdlet")
  touchFailure(state, sig, 's1', 'pytest', { confirmSessions: 3 })
  const pending = new Map([[sig.id, { tool: 'pwsh', kind: sig.kind, subject: sig.subject, command: 'pytest' }]])
  applySuccess(state, 'pwsh', 'python -m pytest', pending, 's1', { confirmSessions: 3 })
  const fact = state.facts.find((f) => f.id === sig.id)
  assert.equal(fact.status, 'forming')
  assert.equal(renderFacts(state, {}), '')
})

check('原样重跑同一条命令不算修法', () => {
  const state = emptyRepo(cwd)
  const sig = signatureOf('pwsh', { command: 'pytest' }, "The term 'pytest' is not recognized as a name of a cmdlet")
  touchFailure(state, sig, 's1', 'pytest', { confirmSessions: 1 })
  const pending = new Map([[sig.id, { tool: 'pwsh', kind: sig.kind, subject: sig.subject, command: 'pytest' }]])
  applySuccess(state, 'pwsh', 'pytest', pending, 's1', { confirmSessions: 1 })
  assert.equal(state.facts[0].fix, null)
})

check('确认后又被新会话推翻两次就丢弃', () => {
  const state = emptyRepo(cwd)
  const sig = signatureOf('pwsh', { command: 'pytest' }, "The term 'pytest' is not recognized as a name of a cmdlet")
  state.facts.push({
    id: sig.id, kind: sig.kind, subject: 'pytest', status: 'confirmed',
    fix: '`python -m pytest`', failedCommand: 'pytest', sessions: ['s1', 's2', 's3'],
    firstSeen: 1, lastSeen: 1, contradictions: 0,
  })
  touchFailure(state, sig, 's4', 'pytest', { confirmSessions: 3, contradictionsToDrop: 2 })
  assert.equal(state.facts[0].status, 'confirmed')
  touchFailure(state, sig, 's5', 'pytest', { confirmSessions: 3, contradictionsToDrop: 2 })
  assert.equal(state.facts[0].status, 'dropped')
  assert.equal(renderFacts(state, {}), '')
})

check('手动事实直接进入提示', () => {
  const state = emptyRepo(cwd)
  state.facts.push({
    id: 'manual:1', kind: 'manual', subject: '测试用 `python -m pytest tests/` 跑',
    status: 'confirmed', fix: null, failedCommand: '', sessions: ['manual'], contradictions: 0,
  })
  const text = renderFacts(state, {})
  assert.match(text, /python -m pytest tests\//)
})

/* ---------------- 循环检测 ---------------- */
check('阈值内不介入，达到阈值转一次，翻倍后只提醒', () => {
  const guard = new LoopGuard({ threshold: 3, nudges: 1 })
  const sig = { id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest' }

  assert.equal(guard.noteFailure('s1', 1, sig).redirect, null)
  assert.equal(guard.noteFailure('s1', 1, sig).redirect, null)
  const third = guard.noteFailure('s1', 1, sig)
  assert.ok(third.redirect, '第三次应当转向')
  assert.match(third.redirect, /pytest/)

  const fourth = guard.noteFailure('s1', 1, sig)
  assert.equal(fourth.redirect, null, '每轮只转向一次')
  const fifth = guard.noteFailure('s1', 1, sig)
  assert.equal(fifth.stillStuck, null)
  const sixth = guard.noteFailure('s1', 1, sig)
  assert.ok(sixth.stillStuck, '翻倍后应当只提醒人')
})

check('换轮次重置计数', () => {
  const guard = new LoopGuard({ threshold: 3, nudges: 1 })
  const sig = { id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest' }
  guard.noteFailure('s1', 1, sig)
  guard.noteFailure('s1', 1, sig)
  guard.startTurn('s1', 2)
  assert.equal(guard.noteFailure('s1', 2, sig).redirect, null)
})

check('有进展就清计数', () => {
  const guard = new LoopGuard({ threshold: 3, nudges: 1 })
  const sig = { id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest' }
  guard.noteFailure('s1', 1, sig)
  guard.noteFailure('s1', 1, sig)
  guard.noteProgress('s1', null)
  assert.equal(guard.noteFailure('s1', 1, sig).redirect, null)
})

/* ---------------- 工具裁剪建议 ---------------- */
check('连续会话加载但从未使用的工具进入建议', () => {
  const state = emptyRepo(cwd)
  for (let i = 0; i < 5; i++) {
    state.sessions.push({ id: `s${i}`, at: Date.now(), loaded: ['read', 'edit', 'notebook'], used: ['read', 'edit'] })
  }
  const proposals = pruneProposals(state, { minSessions: 5 })
  assert.deepEqual(proposals.map((p) => p.name), ['notebook'])
})

check('会话数不够时不给建议', () => {
  const state = emptyRepo(cwd)
  state.sessions.push({ id: 's1', at: Date.now(), loaded: ['notebook'], used: [] })
  assert.deepEqual(pruneProposals(state, { minSessions: 5 }), [])
})

/* ---------------- 工具入口 ---------------- */
async function checkAsync (label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    console.log(`FAIL ${label}`)
    console.log(`     ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

await checkAsync('status 在空仓库上给出可读输出', async () => {
  const runtime = {
    settings: () => ({ confirmSessions: 3, pruneSessions: 5 }),
    loadRepo: () => emptyRepo(cwd),
    cwdOf: () => cwd,
    confirmSessions: 3,
    pruneSessions: 5,
    remember: () => false,
    forget: () => false,
  }
  const tool = createTool(runtime)
  assert.equal(tool.name, 'tokeneconomizer')
  const out = await tool.execute({ action: 'status' }, { agent: null })
  assert.match(out.text, /TokenEconomizer/)
  const blocks = tool.output.render({}, out)
  assert.equal(blocks[0].type, 'text')
})

/* ---------------- 事实时效 ---------------- */
check('久未复核的事实会被标注', () => {
  const state = emptyRepo(cwd)
  const oldSeen = Date.now() - 1_000_000
  state.facts.push({
    id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest', status: 'confirmed',
    fix: '`python -m pytest`', failedCommand: 'pytest', sessions: ['s1', 's2', 's3'],
    firstSeen: 1, lastSeen: oldSeen, contradictions: 0,
  })
  for (let i = 0; i < 20; i++) state.sessions.push({ id: `n${i}`, at: oldSeen + 1000 + i, loaded: [], used: [] })
  assert.equal(sessionsSince(state, oldSeen), 20)
  assert.equal(isStale(state.facts[0], state, 20), true)
  const text = renderFacts(state, { staleSessions: 20 })
  assert.match(text, /久未复核/)
  assert.match(text, /python -m pytest/)
})

check('刚确认的事实不会被标注，过期判据可关', () => {
  const state = emptyRepo(cwd)
  state.facts.push({
    id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest', status: 'confirmed',
    fix: '`python -m pytest`', failedCommand: 'pytest', sessions: ['s1', 's2', 's3'],
    firstSeen: 1, lastSeen: Date.now(), contradictions: 0,
  })
  for (let i = 0; i < 30; i++) state.sessions.push({ id: `n${i}`, at: Date.now() - 5000, loaded: [], used: [] })
  assert.equal(isStale(state.facts[0], state, 20), false)
  assert.doesNotMatch(renderFacts(state, { staleSessions: 20 }), /久未复核/)
  assert.equal(isStale(state.facts[0], state, 0), false)
})

/* ---------------- 签名账本 ---------------- */
check('签名账本记命中次数与会话数，且守上限', () => {
  const state = emptyRepo(cwd)
  const sig = { id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest' }
  recordSignature(state, sig, 's1')
  recordSignature(state, sig, 's2')
  recordSignature(state, sig, 's2')
  const entry = state.signatures['cmd-not-found:pytest']
  assert.equal(entry.count, 3)
  assert.equal(entry.sessions.length, 2)
  assert.equal(signatureCount(state), 1)

  for (let i = 0; i < 80; i++) recordSignature(state, { id: `generic:${i}`, kind: 'generic', subject: 'x' }, 's1')
  assert.ok(signatureCount(state) <= 60, '账本不能无限增长')
  assert.equal(topSignatures(state, 1)[0].id, 'cmd-not-found:pytest')
})

await checkAsync('status 摊开阈值、失败签名与判据', async () => {
  const state = emptyRepo(cwd)
  recordSignature(state, { id: 'cmd-not-found:pytest', kind: 'cmd-not-found', subject: 'pytest' }, 's1')
  const runtime = {
    settings: () => ({ confirmSessions: 3, pruneSessions: 5, contradictionsToDrop: 2, factStaleSessions: 20, loopThreshold: 3 }),
    loadRepo: () => state,
    cwdOf: () => cwd,
    remember: () => false,
    forget: () => false,
  }
  const out = await createTool(runtime).execute({ action: 'status' }, { agent: null })
  assert.match(out.text, /Thresholds in effect/)
  assert.match(out.text, /marked stale after 20 sessions/)
  assert.match(out.text, /cmd-not-found:pytest — 1 hit/)
  assert.match(out.text, /How they are judged/)
})

/* ---------------- 仓库键 ---------------- */
check('不同路径得到不同键，同路径稳定', () => {
  const a = repoKey('C:\\work\\alpha')
  const b = repoKey('C:\\work\\beta')
  assert.notEqual(a, b)
  assert.equal(a, repoKey('C:\\work\\alpha'))
})

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`)
fs.rmSync(tmp, { recursive: true, force: true })
