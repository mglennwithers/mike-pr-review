import { cartTotal, applyCoupon } from './cart.js'

export async function placeOrder(db, user, items, coupon) {
  const total = applyCoupon(cartTotal(items), coupon)
  const order = { userId: user.id, total, items }
  await db.insert('orders', order)
  return { ok: true, order }
}
