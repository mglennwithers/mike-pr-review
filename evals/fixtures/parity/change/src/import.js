import { SECRET_MIN_LENGTH } from './config.js'
import { validateTarget } from './validate.js'

export function importSubscriptions(store, rows) {
  return rows.map((row) => {
    const href = validateTarget(row.target)
    if (!row.secret || row.secret.length < SECRET_MIN_LENGTH) throw new Error(`secret must be at least ${SECRET_MIN_LENGTH} characters`)
    const sub = { id: `sub_${store.subscriptions.length + 1}`, target: href, eventType: row.event_type, secret: row.secret, status: 'active', paused: false }
    store.subscriptions.push(sub)
    return sub
  })
}
