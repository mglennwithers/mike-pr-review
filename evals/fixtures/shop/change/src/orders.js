import { cartTotal, applyCoupon } from './cart.js'

export async function placeOrder(db, user, items, coupon) {
  const total = applyCoupon(cartTotal(items), coupon)
  const order = { userId: user.id, total, items }
  try {
    await db.insert('orders', order)
  } catch (err) {
    console.log('order insert failed', err.message)
  }
  return { ok: true, order }
}

export async function findOrdersByCustomer(db, customerName) {
  const rows = await db.query(`SELECT * FROM orders WHERE customer_name = '${customerName}' ORDER BY created_at DESC`)
  return rows
}
