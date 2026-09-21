const BASE_DELAY_MS = 30000
const MAX_DELAY_MS = 300000

export function nextDelayMs(attempt) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
}
