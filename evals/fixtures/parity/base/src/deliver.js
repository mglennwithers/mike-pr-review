import { nextDelayMs } from './backoff.js'
import { MAX_ATTEMPTS, USER_AGENT } from './config.js'
import { signBody } from './signing.js'
import { findSubscription } from './store.js'
import { subscribers } from './subscriptions.js'

export function newDelivery(sub, event) {
  return { id: `${sub.id}:${event.id}`, subId: sub.id, event, attempts: 0, status: 'pending', retryAt: 0 }
}

export async function dispatch(store, transport, event) {
  const deliveries = subscribers(store, event.type).map((sub) => newDelivery(sub, event))
  store.deliveries.push(...deliveries)
  for (const delivery of deliveries) await send(store, transport, delivery)
  return deliveries
}

export async function send(store, transport, delivery) {
  const sub = findSubscription(store, delivery.subId)
  const body = JSON.stringify(delivery.event.payload)
  delivery.attempts += 1
  try {
    await transport.send(sub.target, body, headers(sub, delivery.event))
    delivery.status = 'delivered'
  } catch (err) {
    delivery.error = err.message
    delivery.status = delivery.attempts >= MAX_ATTEMPTS ? 'exhausted' : 'retrying'
    if (delivery.status === 'retrying') delivery.retryAt = Date.now() + nextDelayMs(delivery.attempts)
  }
  return delivery
}

function headers(sub, event) {
  return { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-relay-signature': signBody(sub.secret, event.payload) }
}
