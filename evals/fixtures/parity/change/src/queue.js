export const nowSeconds = () => Math.floor(Date.now() / 1000)

export function hold(store, delivery) {
  delivery.status = 'held'
  store.held.push(delivery)
  return delivery
}

export function takeHeld(store, subId) {
  const held = store.held.filter((d) => d.subId === subId)
  store.held = store.held.filter((d) => d.subId !== subId)
  for (const delivery of held) delivery.status = 'pending'
  return held
}

export function schedule(delivery, delaySeconds) {
  delivery.retryAt = nowSeconds() + delaySeconds
  return delivery
}

export function due(store, now = nowSeconds()) {
  return store.deliveries.filter((d) => d.status === 'retrying' && d.retryAt <= now)
}
