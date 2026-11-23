/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * lib/loopguard.js — failure-loop intervention：同一轮里反复撞同一面墙时推它一把
 *
 * 上游 TokenEconomizer 的 loop guard 在「一个 turn 里同样的失败反复出现」时
 * 交给裁判模型判断是不是卡住了，确认卡住才插一句转向提示，每轮最多一次；
 * 再卡就只提醒人去按 Esc。这里保留了阈值结构，但**不调用裁判模型**：
 *
 *   - 同一签名在同一个 turn 内累计到 threshold（默认 3）→ 插一次转向提示；
 *   - 提示之后同一签名继续累计到 threshold 的两倍 → 只提醒「可以停」，
 *     绝不自己中断（停机永远是人的决定）；
 *   - 换 turn 归零。
 *
 * 代价是它比上游更容易在「确实在推进但反复踩同一个非致命告警」时多说一句，
 * 所以提示文本写成建议而不是命令，并且每轮只出现一次。
 */

const NUDGE_TEXT = [
  '[TokenEconomizer · loop guard]',
  'The same failure has now repeated several times in this turn: {detail}',
  'Repeating it is unlikely to help. Change one of these instead:',
  '- read the file or error message that matters before retrying;',
  '- narrow the command (one file, one test) to get a smaller error;',
  '- if it is an environment problem, say what is missing and try another route.',
  'Do not run the same command a third time unchanged.',
].join('\n')

const STILL_STUCK_TEXT = [
  '[TokenEconomizer · loop guard]',
  'This turn still looks stuck after a redirect ({detail}).',
  'If the next attempt does not work either, stop this turn and say what is blocking you.',
].join('\n')

export class LoopGuard {
  constructor (options = {}) {
    this.threshold = Math.max(2, options.threshold ?? 3)
    this.nudges = Math.max(1, options.nudges ?? 1)
    /** @type {Map<string, {turn: number, counts: Map<string, number>, redirects: number, notified: boolean}>} */
    this.sessions = new Map()
  }

  stateOf (sessionId, turn) {
    let state = this.sessions.get(sessionId)
    if (!state || state.turn !== turn) {
      state = { turn, counts: new Map(), redirects: 0, notified: false }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  /** 新一轮开始：把上一轮的计数清掉，但保留「这个 turn 已经提醒过」的事实 */
  startTurn (sessionId, turn) {
    this.sessions.set(sessionId, { turn, counts: new Map(), redirects: 0, notified: false })
  }

  forget (sessionId) {
    this.sessions.delete(sessionId)
  }

  /**
   * @returns {{redirect: string|null, stillStuck: string|null, count: number}}
   */
  noteFailure (sessionId, turn, signature) {
    const state = this.stateOf(sessionId, turn ?? 0)
    const next = (state.counts.get(signature.id) ?? 0) + 1
    state.counts.set(signature.id, next)
    // 记住这个签名来自哪个工具，成功时才清得准（B1）
    if (typeof signature.tool === 'string' && signature.tool !== '') {
      if (!state.tools) state.tools = new Map()
      state.tools.set(signature.id, signature.tool)
    }

    const detail = describeSignature(signature)

    // 判据独立于 nudges：正好在 threshold×2 提醒人，不被「还剩几次转向」推迟（B2）。
    if (next >= this.threshold * 2 && !state.notified) {
      state.notified = true
      return { redirect: null, stillStuck: STILL_STUCK_TEXT.replace('{detail}', detail), count: next }
    }

    if (next >= this.threshold && state.redirects < this.nudges) {
      state.redirects += 1
      return { redirect: NUDGE_TEXT.replace('{detail}', detail), stillStuck: null, count: next }
    }

    return { redirect: null, stillStuck: null, count: next }
  }

  /**
   * 同一个工具跑成功了：把它名下的失败签名清掉（B1 的接线）。
   * 只清同一工具，别清全部 —— 否则一个卡住的 turn 里夹着成功的 read 就再也不触发。
   */
  noteSuccess (sessionId, toolName) {
    const state = this.sessions.get(sessionId)
    if (!state || !state.tools) return
    for (const [id, tool] of state.tools) {
      if (tool === toolName) {
        state.counts.delete(id)
        state.tools.delete(id)
      }
    }
  }

  /** 有实质进展时把该签名的计数清掉，避免把「在推进但偶发同样告警」误判成卡死 */
  noteProgress (sessionId, signatureId) {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (signatureId) state.counts.delete(signatureId)
    else state.counts.clear()
  }
}

function describeSignature (signature) {
  const subject = String(signature?.subject ?? '').trim()
  if (signature?.kind === 'cmd-not-found') return `\`${subject}\` is not available here.`
  if (signature?.kind === 'module-missing') return `module \`${subject}\` is missing.`
  if (signature?.kind === 'file-missing') return `\`${subject}\` cannot be found.`
  if (subject === '') return 'the same error came back.'
  // generic 的 subject 是归一化后的报错文本，按词边界截断，别把单词切断
  const clipped = subject.length > 110 ? `${subject.slice(0, 110).replace(/\s+\S*$/, '')}…` : subject
  return `the same error: ${clipped}`
}
