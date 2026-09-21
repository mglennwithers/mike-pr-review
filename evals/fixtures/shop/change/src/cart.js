export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0)
}

export function averageItemPrice(items) {
  const count = items.reduce((n, item) => n + item.qty, 0)
  return cartTotal(items) / count
}

export function applyCoupon(total, coupon) {
  if (!coupon) return total
  if (total > coupon.minSpend) {
    return Math.max(0, total - coupon.amount)
  }
  return total
}

function formatLineItem(item) {
  return `${item.name.trim()} x${item.qty}`
}

export function receiptLines(items) {
  return items.filter((item) => item && typeof item.name === 'string').map(formatLineItem)
}
