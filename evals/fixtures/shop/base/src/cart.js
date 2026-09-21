export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0)
}

export function averageItemPrice(items) {
  if (!items.length) return 0
  const count = items.reduce((n, item) => n + item.qty, 0)
  return cartTotal(items) / count
}

export function applyCoupon(total, coupon) {
  if (!coupon) return total
  if (total >= coupon.minSpend) {
    return Math.max(0, total - coupon.amount)
  }
  return total
}
