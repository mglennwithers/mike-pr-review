# fixture-relay

Webhook relay. A subscription points an event type at a customer endpoint; a matching event is signed and delivered,
with retries when the endpoint is down.

- Targets must be `https://` URLs and must not point into the relay's own network (`src/validate.js`).
- A subscription secret is at least `SECRET_MIN_LENGTH` characters (`src/config.js`).
- Every delivery carries an `x-relay-signature` header over the exact bytes that are sent (`src/signing.js`).
- Retries: the delay doubles from 30 seconds, capped at 5 minutes; after `MAX_ATTEMPTS` attempts the delivery is
  exhausted and `src/deadletter.js` buries it, from where an operator can requeue it.
- A paused subscription receives nothing: its events are held in `src/queue.js` and released when it is resumed.
- `retryAt`, and everything else the queue compares, is in epoch **seconds**.
- `handle(store, transport, req)` in `src/api.js` is the whole HTTP surface; it returns `{ status, body }`.
