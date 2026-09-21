import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ATTEMPTS } from '../src/config.js'
import { requeue, sweep } from '../src/deadletter.js'
import { dispatch, send } from '../src/deliver.js'
import { createStore } from '../src/store.js'
import { createSubscription } from '../src/subscriptions.js'

const EVENT = { id: 'evt_1', type: 'invoice.paid', payload: { invoice: 'inv_1' } }
const REFUSE = { send: async () => { throw new Error('502 from endpoint') } }

function subscribed() {
  const store = createStore()
  createSubscription(store, { target: 'https://hooks.example.com/a', eventType: 'invoice.paid', secret: 'a-long-enough-secret' })
  return store
}

test('a delivery that used up its attempts is buried', async () => {
  const store = subscribed()
  const [delivery] = await dispatch(store, REFUSE, EVENT)
  while (delivery.attempts < MAX_ATTEMPTS) await send(store, REFUSE, delivery)
  assert.equal(delivery.status, 'exhausted')
  assert.equal(sweep(store).length, 1)
  assert.deepEqual(store.deadLetter.map((d) => d.id), [delivery.id])
})

test('a buried delivery can be requeued', async () => {
  const store = subscribed()
  const [delivery] = await dispatch(store, REFUSE, EVENT)
  while (delivery.attempts < MAX_ATTEMPTS) await send(store, REFUSE, delivery)
  sweep(store)
  const [redelivered] = await requeue(store, { send: async () => {} }, delivery.id)
  assert.equal(redelivered.status, 'delivered')
  assert.equal(store.deadLetter.length, 0)
})
