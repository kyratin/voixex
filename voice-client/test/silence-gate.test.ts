import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SilenceGate } from '../src/silence-gate.js'
test('digital silence stops; quiet speech starts immediately and keeps a short tail', () => {
  const gate = new SilenceGate(), silence = new Int16Array(960)
  assert.equal(gate.admit(silence,1000),false)
  const quiet = Int16Array.from({length:960},(_,i)=>Math.round(12*Math.sin(i*.1)))
  assert.equal(gate.admit(quiet,1020),true)
  assert.equal(gate.admit(silence,1100),true)
  assert.equal(gate.admit(silence,1200),false)
  assert.equal(gate.admit(quiet,1220),true)
  gate.reset();assert.equal(gate.admit(silence,1221),false)
})
