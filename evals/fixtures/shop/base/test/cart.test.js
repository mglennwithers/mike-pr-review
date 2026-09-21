import test from 'node:test'
import assert from 'node:assert/strict'
import { cartTotal, averageItemPrice, applyCoupon } from '../src/cart.js'

test('cartTotal sums price * qty', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25)
})
test('averageItemPrice of empty cart is 0', () => {
  assert.equal(averageItemPrice([]), 0)
})
test('coupon applies at the minimum spend', () => {
  assert.equal(applyCoupon(50, { minSpend: 50, amount: 10 }), 40)
})
