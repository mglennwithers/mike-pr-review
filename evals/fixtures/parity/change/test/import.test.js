import test from 'node:test'
import assert from 'node:assert/strict'
import { importSubscriptions } from '../src/import.js'
import { createStore } from '../src/store.js'
import { subscribers } from '../src/subscriptions.js'

const ROW = { target: 'https://hooks.example.com/imported', event_type: 'invoice.paid', secret: 'a-long-enough-secret' }

test('rows become active subscriptions', () => {
  const store = createStore()
  const created = importSubscriptions(store, [ROW])
  assert.equal(created.length, 1)
  assert.deepEqual(subscribers(store, 'invoice.paid').map((s) => s.id), [created[0].id])
})

test('a row with an http target is rejected', () => {
  assert.throws(() => importSubscriptions(createStore(), [{ ...ROW, target: 'http://hooks.example.com/imported' }]), /https/)
})
