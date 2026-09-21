export function createStore() {
  return { subscriptions: [], deliveries: [] }
}

export function findSubscription(store, id) {
  const sub = store.subscriptions.find((s) => s.id === id)
  if (!sub) throw new Error(`unknown subscription: ${id}`)
  return sub
}
