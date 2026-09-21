const INTERNAL_HOST = /^(localhost$|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/

export function validateTarget(target) {
  let url
  try {
    url = new URL(target)
  } catch {
    throw new Error(`invalid target: ${target}`)
  }
  if (url.protocol !== 'https:') throw new Error('target must use https')
  return url.href
}

export function assertNotInternal(target) {
  const { hostname } = new URL(target)
  if (INTERNAL_HOST.test(hostname)) throw new Error(`target points into the relay's own network: ${hostname}`)
}
