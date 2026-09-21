# fixture-relay

Webhook relay. A subscription points an event type at a customer endpoint; a matching event is signed and delivered,
with retries when the endpoint is down.

- Targets must be `https://` URLs (`src/validate.js`).
- A subscription secret is at least `SECRET_MIN_LENGTH` characters (`src/config.js`).
- Every delivery carries an `x-relay-signature` header over the exact bytes that are sent (`src/signing.js`).
- Retries: the delay doubles from 30 seconds, capped at 5 minutes; after `MAX_ATTEMPTS` attempts the delivery is exhausted.
- `handle(store, transport, req)` in `src/api.js` is the whole HTTP surface; it returns `{ status, body }`.
