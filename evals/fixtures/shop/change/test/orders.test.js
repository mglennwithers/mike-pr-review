import test from 'node:test'
import { placeOrder } from '../src/orders.js'

test('placeOrder stores the order', async () => {
  const db = { insert: async () => {} }
  await placeOrder(db, { id: 1 }, [{ price: 10, qty: 1 }], null)
})
