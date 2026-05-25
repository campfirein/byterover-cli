export type DocsAgent = {
  docsUrl: string
  name: string
}

export const DOCS_AGENTS: readonly DocsAgent[] = [
  {
    docsUrl: 'https://docs.byterover.dev/autonomous-agents/openclaw',
    name: 'OpenClaw',
  },
  {
    docsUrl: 'https://docs.byterover.dev/autonomous-agents/hermes',
    name: 'Hermes',
  },
]

export const DOCS_AGENT_NAMES: ReadonlySet<string> = new Set(DOCS_AGENTS.map((d) => d.name))
