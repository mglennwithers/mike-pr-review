import { MAX_ATTEMPTS } from './config.js'
import { dispatch, resume } from './deliver.js'
import { importSubscriptions } from './import.js'
import { replay } from './replay.js'
import { findSubscription } from './store.js'
import { createSubscription, setPaused } from './subscriptions.js'

const subIdFrom = (path) => path.split('/')[2]

export async function handle(store, transport, req) {
  if (req.method === 'POST' && req.path === '/subscriptions') {
    try {
      return { status: 201, body: createSubscription(store, req.body) }
    } catch (err) {
      return { status: 400, body: { error: err.message } }
    }
  }
  if (req.method === 'POST' && req.path.endsWith('/pause')) {
    try {
      const sub = setPaused(store, subIdFrom(req.path), true)
      return { status: 200, body: { id: sub.id, paused: true, message: 'Paused. Events for this endpoint are dropped until you resume it.' } }
    } catch (err) {
      return { status: 404, body: { error: err.message } }
    }
  }
  if (req.method === 'POST' && req.path.endsWith('/resume')) {
    try {
      const sub = findSubscription(store, subIdFrom(req.path))
      await resume(store, transport, sub.id)
      return { status: 200, body: { id: sub.id, paused: false } }
    } catch (err) {
      return { status: 404, body: { error: err.message } }
    }
  }
  if (req.method === 'POST' && req.path === '/events') {
    const deliveries = await dispatch(store, transport, req.body)
    return { status: 202, body: { accepted: deliveries.length } }
  }
  if (req.method === 'POST' && req.path === '/admin/import') {
    try {
      return { status: 201, body: { imported: importSubscriptions(store, req.body.rows).length } }
    } catch (err) {
      return { status: 400, body: { error: err.message } }
    }
  }
  if (req.method === 'POST' && req.path === '/admin/replay') {
    const deliveries = await replay(store, transport, req.body.event)
    return { status: 202, body: { replayed: deliveries.length } }
  }
  if (req.method === 'GET' && req.path.startsWith('/deliveries/')) {
    const delivery = store.deliveries.find((d) => d.id === req.path.slice('/deliveries/'.length))
    if (!delivery) return { status: 404, body: { error: 'unknown delivery' } }
    return { status: 200, body: { id: delivery.id, status: delivery.status, attempts: delivery.attempts, attempts_left: Math.max(0, MAX_ATTEMPTS - delivery.attempts) } }
  }
  return { status: 404, body: { error: 'not found' } }
}
