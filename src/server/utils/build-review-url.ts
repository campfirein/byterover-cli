import {encodeBase64Url} from './base64url.js'

export function buildReviewUrl(webuiPort: number, projectPath: string): string {
  return `http://localhost:${webuiPort}/changes?project=${encodeBase64Url(projectPath)}`
}
