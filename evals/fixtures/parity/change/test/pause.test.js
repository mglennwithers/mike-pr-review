import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatch, resume } from '../src/deliver.js'
import { createStore } from '../src/store.js'
import { createSubscription, setPaused } from '../src/subscriptions.js'

const EVENT = { id: 'evt_1', type: 'invoice.paid', payload: { invoice: 'inv_1' } }

function paused() {
  const store = createStore()
  const sub = createSubscription(store, { target: 'https://hooks.example.com/a', eventType: 'invoice.paid', secret: 'a-long-enough-secret' })
  setPaused(store, sub.id, true)
  return { store, sub }
}

test('a paused subscription is not delivered to', async () => {
  const { store } = paused()
  const transport = { send: async () => { throw new Error('the endpoint must not be called') } }
  const [delivery] = await dispatch(store, transport, EVENT)
  assert.equal(delivery.status, 'held')
  assert.equal(store.held.length, 1)
})

test('resuming releases what was held', async () => {
  const { store, sub } = paused()
  await dispatch(store, { send: async () => { throw new Error('the endpoint must not be called') } }, EVENT)
  const sent = []
  await resume(store, { send: async (url) => sent.push(url) }, sub.id)
  assert.deepEqual(sent, ['https://hooks.example.com/a'])
  assert.equal(store.held.length, 0)
})
