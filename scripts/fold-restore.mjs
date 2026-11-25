#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * fold-restore.mjs — out-of-band restore for tool folding.
 *
 * The in-session fold can hide tokeneconomizer itself if a deployment enables
 * apply mode with a buggy threshold. This script does not depend on the tool:
 * it writes restoreAll into fold-state.json, which the plugin reads at startup,
 * folds nothing for that process, and clears.
 *
 * usage: node scripts/fold-restore.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh')
const statePath = path.join(home, 'tokeneconomizer', 'fold-state.json')

let state = {}
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch { state = {} }
state.restoreAll = true
state.seen = {}
fs.mkdirSync(path.dirname(statePath), { recursive: true })
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log('fold-restore: next DSH start will not fold anything; evidence cleared (' + statePath + ')')
