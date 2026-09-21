import test from 'node:test'
import assert from 'node:assert/strict'
import { due, nowSeconds, schedule } from '../src/queue.js'

test('a scheduled delivery is due once its delay has passed', () => {
  const delivery = { id: 'sub_1:evt_1', subId: 'sub_1', status: 'retrying', retryAt: 0 }
  const store = { deliveries: [delivery] }
  schedule(delivery, 60)
  assert.equal(due(store).length, 0)
  assert.equal(due(store, nowSeconds() + 60).length, 1)
})
