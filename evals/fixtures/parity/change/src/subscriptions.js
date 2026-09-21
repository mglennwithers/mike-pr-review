import { SECRET_MIN_LENGTH } from './config.js'
import { findSubscription } from './store.js'
import { assertNotInternal, validateTarget } from './validate.js'

export function createSubscription(store, { target, eventType, secret }) {
  const href = validateTarget(target)
  assertNotInternal(href)
  if (!secret || secret.length < SECRET_MIN_LENGTH) throw new Error(`secret must be at least ${SECRET_MIN_LENGTH} characters`)
  const sub = { id: `sub_${store.subscriptions.length + 1}`, target: href, eventType, secret, status: 'active', paused: false }
  store.subscriptions.push(sub)
  return sub
}

export function subscribers(store, eventType) {
  return store.subscriptions.filter((s) => s.eventType === eventType && s.status === 'active')
}

export function isDeliverable(sub) {
  return sub.status === 'active' && !sub.paused
}

export function setPaused(store, id, paused) {
  const sub = findSubscription(store, id)
  sub.paused = paused
  return sub
}
