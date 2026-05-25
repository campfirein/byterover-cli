const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

export function encodeBase64Url(s: string): string {
  if (s === '') return ''
  const bytes = TEXT_ENCODER.encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCodePoint(b)
  // eslint-disable-next-line no-restricted-globals
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeBase64Url(s: string): string {
  if (s === '') return ''
  const restored = s.replaceAll('-', '+').replaceAll('_', '/')
  const padded = restored.length % 4 === 0 ? restored : restored + '='.repeat(4 - (restored.length % 4))
  // eslint-disable-next-line no-restricted-globals
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0
  return TEXT_DECODER.decode(bytes, {stream: false})
}
