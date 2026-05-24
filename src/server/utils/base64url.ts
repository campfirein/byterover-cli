export function encodeBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url')
}

export function decodeBase64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8')
}
