/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * test/fold.mjs — 折叠模块的时序自测（假 ctx，不需要 DSH 运行时）
 *
 * 假 ctx 按 dsh-tools 的真实语义建模：restrict 往 scope 追加一条限制，
 * 解除函数移除那一条（不是把名字删掉），多条限制取交集。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 node test/fold.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NAMES = ['a1', 'a2', 'a3', 'a4', 'a5']

function makeTools (names = NAMES) {
  const registered = new Set(names)
  const restrictions = []
  const stats = { calls: 0, disposes: 0, fail: false }
  const hidden = () => names.filter((n) => restrictions.some((r) => r.deny.has(n)))
  return {
    stats,
    hidden,
    get (name) {
      if (!registered.has(name)) return undefined
      if (restrictions.some((r) => r.deny.has(name))) return undefined
      return { name, description: 'desc of ' + name, parameters: {} }
    },
    definitions () {
      return names
        .filter((n) => !restrictions.some((r) => r.deny.has(n)))
        .map((n) => ({ name: n, description: 'desc of ' + n, parameters: {} }))
    },
    restrict ({ deny }) {
      stats.calls += 1
      if (stats.fail) throw new Error('unknown global tool "ghost"')
      const unknown = deny.filter((n) => !registered.has(n))
      if (unknown.length > 0) throw new Error('unknown global tool ' + unknown.join(', '))
      const entry = { deny: new Set(deny) }
      restrictions.push(entry)
      let lifted = false
      return () => {
        stats.disposes += 1
        if (lifted) return
        lifted = true
        const i = restrictions.indexOf(entry)
        if (i >= 0) restrictions.splice(i, 1)
      }
    }
  }
}

let passed = 0
function check (label, fn) {
  try { fn(); passed += 1; console.log('ok   ' + label) }
  catch (e) { console.log('FAIL ' + label + '\n     ' + (e instanceof Error ? e.message : String(e))); process.exitCode = 1 }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'te-fold-'))
const statePath = path.join(tmp, 'fold-state.json')

const { createFolder } = await import('../lib/fold.js')

function makeAgent (id, tools) { return { id, ctx: { tools } } }

const tools = makeTools()
const agent = makeAgent('session-A', tools)
const folder = createFolder({ names: NAMES, statePath })
const step = (f = folder, a = agent) => f.onPreStep(a)

check('开局只装一次，全部折叠', () => {
  step()
  assert.equal(tools.stats.calls, 1)
  assert.equal(tools.hidden().length, NAMES.length)
})

check('后续 pre-step 走快路径，不再重装', () => {
  step(); step()
  assert.equal(tools.stats.calls, 1)
  assert.equal(tools.stats.disposes, 0)
})

check('load 只记账，不在同一回合改工具表', () => {
  const result = folder.load('session-A', 'a1')
  assert.equal(result.ok, true)
  assert.equal(tools.stats.calls, 1, 'load 不应触发 restrict')
  assert.equal(tools.get('a1'), undefined, '下一个 pre-step 之前 a1 仍折着')
})

check('下一次 pre-step 才生效：拆旧的、装新的', () => {
  step()
  assert.equal(tools.stats.calls, 2)
  assert.equal(tools.stats.disposes, 1)
  assert.equal(tools.hidden().length, NAMES.length - 1)
  assert.notEqual(tools.get('a1'), undefined)
})

check('restrict 抛错时不拆旧限制', () => {
  const d0 = tools.stats.disposes
  const hidden0 = tools.hidden().length
  tools.stats.fail = true
  step()
  assert.equal(tools.stats.disposes, d0, '装失败时不许 dispose')
  assert.equal(tools.hidden().length, hidden0)
  tools.stats.fail = false
})

check('全新会话首次安装失败 → 无半套限制，恢复后可装上且随后稳定', () => {
  const freshTools = makeTools()
  const freshAgent = makeAgent('session-B', freshTools)
  const freshFolder = createFolder({ names: NAMES, statePath: path.join(tmp, 'b.json') })
  freshTools.stats.fail = true
  freshFolder.onPreStep(freshAgent)
  assert.equal(freshTools.hidden().length, 0)
  const callsAfterFail = freshTools.stats.calls
  freshTools.stats.fail = false
  freshFolder.onPreStep(freshAgent)
  assert.equal(freshTools.stats.calls, callsAfterFail + 1)
  assert.equal(freshTools.hidden().length, NAMES.length)
  const settled = freshTools.stats.calls
  freshFolder.onPreStep(freshAgent)
  assert.equal(freshTools.stats.calls, settled, '成功之后必须稳定')
})

check('用过一次就落盘，并且下一个实例不再折叠它', () => {
  folder.recordUse('a3')
  folder.flush()
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.used.a3, 1)

  const nextTools = makeTools()
  const nextAgent = makeAgent('session-C', nextTools)
  const nextFolder = createFolder({ names: NAMES, statePath })
  nextFolder.onPreStep(nextAgent)
  assert.equal(nextTools.hidden().length, NAMES.length - 1, '用过的 a3 应免折')
  assert.notEqual(nextTools.get('a3'), undefined)
})

// ---- 动态折叠：只认证据，不认名字 ----
const dynState = path.join(tmp, 'dyn.json')
const dynTools = makeTools()
const dynFolder = createFolder({ afterSessions: 2, statePath: dynState })

check('动态模式首次会话不折叠（没有证据）', () => {
  dynFolder.onPreStep(makeAgent('dyn-1', dynTools))
  assert.equal(dynTools.hidden().length, 0)
})

check('连续第二个会话零调用后才进入候选', () => {
  dynFolder.onPreStep(makeAgent('dyn-2', dynTools))
  assert.equal(dynTools.hidden().length, NAMES.length)
})

check('用过的工具不进入候选', () => {
  const usedTools = makeTools()
  const usedFolder = createFolder({ afterSessions: 2, statePath: path.join(tmp, 'used.json') })
  usedFolder.onPreStep(makeAgent('u-1', usedTools))
  usedFolder.recordUse('a1')
  usedFolder.onPreStep(makeAgent('u-2', usedTools))
  assert.equal(usedTools.hidden().includes('a1'), false)
  assert.equal(usedTools.hidden().length, NAMES.length - 1)
})

check('keep 名单在动态模式下同样生效', () => {
  const keepTools = makeTools()
  const keepFolder = createFolder({ afterSessions: 2, keep: ['a5'], statePath: path.join(tmp, 'keep.json') })
  keepFolder.onPreStep(makeAgent('k-1', keepTools))
  keepFolder.onPreStep(makeAgent('k-2', keepTools))
  assert.equal(keepTools.hidden().includes('a5'), false)
})

const status = folder.status('session-A')
check('status 摊开折叠数/字节/重装次数', () => {
  assert.equal(status.folded, NAMES.length)
  assert.ok(status.bytes > 0)
  assert.ok(status.reinstalls >= 1)
})

console.log('\n' + passed + ' checks passed')
fs.rmSync(tmp, { recursive: true, force: true })
