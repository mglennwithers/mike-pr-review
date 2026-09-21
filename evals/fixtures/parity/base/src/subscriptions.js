import { SECRET_MIN_LENGTH } from './config.js'
import { validateTarget } from './validate.js'

export function createSubscription(store, { target, eventType, secret }) {
  const href = validateTarget(target)
  if (!secret || secret.length < SECRET_MIN_LENGTH) throw new Error(`secret must be at least ${SECRET_MIN_LENGTH} characters`)
  const sub = { id: `sub_${store.subscriptions.length + 1}`, target: href, eventType, secret, status: 'active' }
  store.subscriptions.push(sub)
  return sub
}

export function subscribers(store, eventType) {
  return store.subscriptions.filter((s) => s.eventType === eventType && s.status === 'active')
}
