import test from 'node:test'
import assert from 'node:assert/strict'
import { nextDelayMs } from '../src/backoff.js'

test('the retry delay doubles per attempt', () => {
  assert.equal(nextDelayMs(1), 30000)
  assert.equal(nextDelayMs(2), 60000)
  assert.equal(nextDelayMs(3), 120000)
})

test('the retry delay is capped', () => {
  assert.equal(nextDelayMs(9), 300000)
})
