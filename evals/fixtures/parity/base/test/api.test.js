import test from 'node:test'
import assert from 'node:assert/strict'
import { handle } from '../src/api.js'
import { createStore } from '../src/store.js'

const SUB = { target: 'https://hooks.example.com/a', eventType: 'invoice.paid', secret: 'a-long-enough-secret' }
const EVENT = { id: 'evt_1', type: 'invoice.paid', payload: { invoice: 'inv_1' } }

test('a subscription is created and then receives an event', async () => {
  const store = createStore()
  const transport = { send: async () => {} }
  const created = await handle(store, transport, { method: 'POST', path: '/subscriptions', body: SUB })
  assert.equal(created.status, 201)
  const accepted = await handle(store, transport, { method: 'POST', path: '/events', body: EVENT })
  assert.deepEqual(accepted, { status: 202, body: { accepted: 1 } })
})

test('a bad target is a 400', async () => {
  const store = createStore()
  const res = await handle(store, { send: async () => {} }, { method: 'POST', path: '/subscriptions', body: { ...SUB, target: 'ftp://hooks.example.com/a' } })
  assert.equal(res.status, 400)
})

test('an unknown delivery is a 404', async () => {
  const res = await handle(createStore(), { send: async () => {} }, { method: 'GET', path: '/deliveries/nope' })
  assert.equal(res.status, 404)
})
