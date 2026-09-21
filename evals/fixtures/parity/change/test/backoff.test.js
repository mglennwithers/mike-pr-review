import test from 'node:test'
import assert from 'node:assert/strict'
import { nextDelay } from '../src/backoff.js'

test('the retry delay doubles per attempt', () => {
  assert.equal(nextDelay(1), 30)
  assert.equal(nextDelay(2), 60)
  assert.equal(nextDelay(3), 120)
})

test('the retry delay is capped', () => {
  assert.equal(nextDelay(9), 3600)
})
