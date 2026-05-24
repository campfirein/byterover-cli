/** Transport events for context tree operations (webui ↔ daemon). */
export const ContextTreeEvents = {
  GET_FILE: 'contextTree:getFile',
  GET_FILE_METADATA: 'contextTree:getFileMetadata',
  GET_HISTORY: 'contextTree:getHistory',
  GET_NODES: 'contextTree:getNodes',
  UPDATE_FILE: 'contextTree:updateFile',
} as const

// --- GET_NODES ---

export interface ContextTreeGetNodesRequest {
  /** Branch to read from. Defaults to current checked-out branch if omitted. */
  branch?: string
  /** Explicit project path. When omitted, uses the client's registered project. */
  projectPath?: string
}

/** A node in the context tree hierarchy (file or directory). */
export interface ContextTreeNodeDTO {
  /** Child nodes (only present for `type: 'tree'`). */
  children?: ContextTreeNodeDTO[]
  /** File or directory name (e.g. `"auth.md"`, `"architecture"`). */
  name: string
  /** Relative path within the context tree (e.g. `"architecture/auth.md"`). */
  path: string
  /** `'tree'` for directories, `'blob'` for files. */
  type: 'blob' | 'tree'
}

export interface ContextTreeGetNodesResponse {
  /** The resolved branch name. */
  branch: string
  /** Hierarchical tree of nodes, pre-sorted (folders first, then alphabetical). */
  nodes: ContextTreeNodeDTO[]
}

// --- GET_FILE ---

export interface ContextTreeGetFileRequest {
  branch?: string
  /** Relative path within the context tree (e.g. `"architecture/auth.md"`). */
  path: string
  /** Explicit project path. When omitted, uses the client's registered project. */
  projectPath?: string
}

/** Parsed context file with extracted metadata. */
export interface ContextTreeFileDTO {
  /** Raw file content (markdown with frontmatter). */
  content: string
  /** Relative path within the context tree. */
  path: string
  /** Tags extracted from frontmatter. */
  tags: string[]
  /** Title extracted from frontmatter or first H1 heading. */
  title: string
}

export interface ContextTreeGetFileResponse {
  file: ContextTreeFileDTO
}

// --- UPDATE_FILE ---

export interface ContextTreeUpdateFileRequest {
  branch?: string
  /** New file content to write. */
  content: string
  /** Relative path within the context tree. */
  path: string
  /** Explicit project path. When omitted, uses the client's registered project. */
  projectPath?: string
}

export interface ContextTreeUpdateFileResponse {
  success: boolean
}

// --- GET_FILE_METADATA ---

export interface ContextTreeGetFileMetadataRequest {
  /**
   * File or folder paths to fetch metadata for. Folder paths resolve to the
   * latest commit that modified any descendant of the folder.
   */
  paths: string[]
  /** Explicit project path. When omitted, uses the client's registered project. */
  projectPath?: string
}

export interface ContextTreeFileMetadataDTO {
  lastUpdatedBy?: string
  lastUpdatedWhen?: string
  path: string
}

export interface ContextTreeGetFileMetadataResponse {
  files: ContextTreeFileMetadataDTO[]
}

// --- GET_HISTORY ---

export interface ContextTreeGetHistoryRequest {
  /** SHA of the last commit from the previous page (for cursor-based pagination). */
  cursor?: string
  /** Max commits per page. Defaults to 10. */
  limit?: number
  /** File path to filter history for (e.g. `"architecture/auth.md"`). */
  path: string
  /** Explicit project path. When omitted, uses the client's registered project. */
  projectPath?: string
}

/** A single commit in the context tree's git history. */
export interface ContextTreeHistoryCommitDTO {
  author: {email: string; name: string}
  message: string
  /** Full commit SHA. */
  sha: string
  /** ISO 8601 timestamp. */
  timestamp: string
}

export interface ContextTreeGetHistoryResponse {
  commits: ContextTreeHistoryCommitDTO[]
  /** Whether more commits are available after this page. */
  hasMore: boolean
  /** Cursor to pass in the next request to fetch the next page. */
  nextCursor?: string
}
