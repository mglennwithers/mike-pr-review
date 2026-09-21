import { createHmac } from 'node:crypto'

export function signBody(secret, body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}
