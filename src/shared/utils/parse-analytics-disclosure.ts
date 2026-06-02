export type AnalyticsDisclosureSection = {
  body: string
  label: string
}

const H2_PATTERN = /^##\s+(.+?)\s*$/

export function parseAnalyticsDisclosure(markdown: string): AnalyticsDisclosureSection[] {
  const sections: AnalyticsDisclosureSection[] = []
  let currentLabel: string | undefined
  let currentBodyLines: string[] = []

  for (const line of markdown.split('\n')) {
    const match = H2_PATTERN.exec(line)
    if (match) {
      if (currentLabel !== undefined) {
        sections.push({body: currentBodyLines.join('\n').trim(), label: currentLabel})
      }

      currentLabel = match[1]
      currentBodyLines = []
      continue
    }

    if (currentLabel !== undefined) currentBodyLines.push(line)
  }

  if (currentLabel !== undefined) {
    sections.push({body: currentBodyLines.join('\n').trim(), label: currentLabel})
  }

  return sections
}
