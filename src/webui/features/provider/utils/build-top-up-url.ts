export function buildTopUpUrl({
  teamSlug,
  webAppUrl,
}: {
  teamSlug?: string
  webAppUrl?: string
}): string | undefined {
  if (!teamSlug || !webAppUrl) return undefined
  const base = webAppUrl.replace(/\/+$/, '')
  return `${base}/settings/${encodeURIComponent(teamSlug)}/billing`
}
