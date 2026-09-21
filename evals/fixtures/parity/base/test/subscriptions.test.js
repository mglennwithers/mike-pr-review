import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'
import { createSubscription, subscribers } from '../src/subscriptions.js'

test('an https target is accepted and becomes a subscriber', () => {
  const store = createStore()
  const sub = createSubscription(store, { target: 'https://hooks.example.com/a', eventType: 'invoice.paid', secret: 'a-long-enough-secret' })
  assert.equal(sub.status, 'active')
  assert.deepEqual(subscribers(store, 'invoice.paid').map((s) => s.id), [sub.id])
})

test('an http target is rejected', () => {
  const store = createStore()
  assert.throws(() => createSubscription(store, { target: 'http://hooks.example.com/a', eventType: 'invoice.paid', secret: 'a-long-enough-secret' }), /https/)
})

test('a short secret is rejected', () => {
  const store = createStore()
  assert.throws(() => createSubscription(store, { target: 'https://hooks.example.com/a', eventType: 'invoice.paid', secret: 'short' }), /secret/)
})
