export type AnalyticsDisclosureSection = {
  body: string
  label: string
}

const H2_PATTERN = /^##\s+(.+?)\s*$/

export function parseAnalyticsDisclosure(markdown: string): AnalyticsDisclosureSection[] {
  const sections: AnalyticsDisclosureSection[] = []
  let currentLabel: string | undefined
  let currentBodyLines: string[] = []

  function pushCurrent() {
    if (currentLabel === undefined) return
    const body = currentBodyLines.join('\n').trim()
    if (body.length > 0) sections.push({body, label: currentLabel})
  }

  for (const line of markdown.split('\n')) {
    const match = H2_PATTERN.exec(line)
    if (match) {
      pushCurrent()
      currentLabel = match[1]
      currentBodyLines = []
      continue
    }

    if (currentLabel !== undefined) currentBodyLines.push(line)
  }

  pushCurrent()
  return sections
}
