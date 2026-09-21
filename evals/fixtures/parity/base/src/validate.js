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
