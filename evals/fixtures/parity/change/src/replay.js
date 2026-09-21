import { newDelivery, send } from './deliver.js'

export async function replay(store, transport, event) {
  const targets = store.subscriptions.filter((s) => s.eventType === event.type && s.status === 'active')
  const deliveries = targets.map((sub) => newDelivery(sub, { ...event, id: `${event.id}:replay` }))
  store.deliveries.push(...deliveries)
  for (const delivery of deliveries) await send(store, transport, delivery)
  return deliveries
}
