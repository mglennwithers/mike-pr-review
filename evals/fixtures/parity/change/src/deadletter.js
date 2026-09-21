import { dispatch } from './deliver.js'

const GIVE_UP_AFTER = 5

export function sweep(store) {
  const buried = store.deliveries.filter((d) => ['retrying', 'exhausted'].includes(d.status) && d.attempts >= GIVE_UP_AFTER)
  for (const delivery of buried) {
    delivery.status = 'dead'
    store.deadLetter.push(delivery)
  }
  return buried
}

export async function requeue(store, transport, deliveryId) {
  const buried = store.deadLetter.find((d) => d.id === deliveryId)
  if (!buried) throw new Error(`unknown dead letter: ${deliveryId}`)
  store.deadLetter = store.deadLetter.filter((d) => d !== buried)
  store.deliveries = store.deliveries.filter((d) => d !== buried)
  return dispatch(store, transport, buried.event, { only: buried.subId })
}
