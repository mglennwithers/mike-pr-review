import { MAX_ATTEMPTS } from './config.js'
import { dispatch } from './deliver.js'
import { createSubscription } from './subscriptions.js'

export async function handle(store, transport, req) {
  if (req.method === 'POST' && req.path === '/subscriptions') {
    try {
      return { status: 201, body: createSubscription(store, req.body) }
    } catch (err) {
      return { status: 400, body: { error: err.message } }
    }
  }
  if (req.method === 'POST' && req.path === '/events') {
    const deliveries = await dispatch(store, transport, req.body)
    return { status: 202, body: { accepted: deliveries.length } }
  }
  if (req.method === 'GET' && req.path.startsWith('/deliveries/')) {
    const delivery = store.deliveries.find((d) => d.id === req.path.slice('/deliveries/'.length))
    if (!delivery) return { status: 404, body: { error: 'unknown delivery' } }
    return { status: 200, body: { id: delivery.id, status: delivery.status, attempts: delivery.attempts, attempts_left: Math.max(0, MAX_ATTEMPTS - delivery.attempts) } }
  }
  return { status: 404, body: { error: 'not found' } }
}
