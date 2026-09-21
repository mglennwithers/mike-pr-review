const BASE_DELAY = 30
const MAX_DELAY = 3600

export function nextDelay(attempt) {
  return Math.min(MAX_DELAY, BASE_DELAY * 2 ** (attempt - 1))
}
