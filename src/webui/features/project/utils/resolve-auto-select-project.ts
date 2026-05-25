import {decodeBase64Url} from '../../../lib/base64url'

interface AutoSelectInput {
  projectCwd?: string
  projects: Array<{projectPath: string}>
  selectedProject?: string
  urlParam?: string
}

export function resolveAutoSelectProject(input: AutoSelectInput): string | undefined {
  const knownPaths = new Set(input.projects.map((p) => p.projectPath))

  if (input.urlParam) {
    try {
      const decoded = decodeBase64Url(input.urlParam)
      if (knownPaths.has(decoded)) return decoded
    } catch {
      // fall through
    }
  }

  if (input.selectedProject) return undefined

  if (input.projectCwd && knownPaths.has(input.projectCwd)) {
    return input.projectCwd
  }

  return undefined
}
