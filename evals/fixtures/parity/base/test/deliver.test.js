import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatch } from '../src/deliver.js'
import { createStore } from '../src/store.js'
import { createSubscription } from '../src/subscriptions.js'

const EVENT = { id: 'evt_1', type: 'invoice.paid', payload: { invoice: 'inv_1', cents: 2500 } }

function subscribed() {
  const store = createStore()
  createSubscription(store, { target: 'https://hooks.example.com/a', eventType: 'invoice.paid', secret: 'a-long-enough-secret' })
  return store
}

test('a delivery is signed and marked delivered', async () => {
  const store = subscribed()
  const sent = []
  const transport = { send: async (url, body, headers) => sent.push({ url, body, headers }) }
  const [delivery] = await dispatch(store, transport, EVENT)
  assert.equal(delivery.status, 'delivered')
  assert.equal(sent[0].url, 'https://hooks.example.com/a')
  assert.match(sent[0].headers['x-relay-signature'], /^sha256=[0-9a-f]{64}$/)
})

test('a refused delivery is counted and scheduled for a retry', async () => {
  const store = subscribed()
  const transport = { send: async () => { throw new Error('502 from endpoint') } }
  const [delivery] = await dispatch(store, transport, EVENT)
  assert.equal(delivery.status, 'retrying')
  assert.equal(delivery.attempts, 1)
  assert.ok(delivery.retryAt > 0)
})
