export const BRV_DIR = '.brv'
export const API_V1_PATH = '/api/v1'
export const PROJECT_CONFIG_FILE = 'config.json'
export const BRV_CONFIG_VERSION = '0.0.1'

// Worktree linking (git-style: .brv is a file pointing to parent project)
export const WORKTREES_DIR = 'worktrees'
export const WORKTREE_LINK_METADATA = 'link.json'

// Knowledge sources (read-only references to other projects)
export const SOURCES_FILE = 'sources.json'
export const SHARED_SOURCE_LOCAL_SCORE_BOOST = 0.1
export const MCP_ASSOCIATE_PROJECT_TIMEOUT_MS = 3000
export const MCP_ASSOCIATE_PROJECT_MAX_ATTEMPTS = 2

// Global config constants (user-level, stored in XDG config directory)
export const GLOBAL_CONFIG_DIR = 'brv'
export const GLOBAL_CONFIG_FILE = 'config.json'
export const GLOBAL_CONFIG_VERSION = '0.0.1'

// Global data directory name (for XDG_DATA_HOME - secrets, credentials, cache)
// Same value as GLOBAL_CONFIG_DIR but different semantic purpose
export const GLOBAL_DATA_DIR = 'brv'

export const PROJECT = 'byterover'

// Context Tree directory structure constants
export const CONTEXT_TREE_DIR = 'context-tree'
export const CONTEXT_TREE_BACKUP_DIR = 'context-tree-backup'
export const CONTEXT_TREE_CONFLICT_DIR = 'context-tree-conflicts'
export const CONTEXT_FILE = 'context.md'
export const CONTEXT_FILE_EXTENSION = '.md'
export const README_FILE = 'README.md'
export const SNAPSHOT_FILE = '.snapshot.json'

/**
 * Default ByteRover branch name for memory storage.
 * This is ByteRover's internal branching mechanism, not Git branches.
 */
export const DEFAULT_BRANCH = 'main'

// Transport layer constants (optimized for localhost real-time)
export const TRANSPORT_HOST = '127.0.0.1' // Use IP address for better sandbox compatibility
export const TRANSPORT_SPACE_SWITCH_TIMEOUT_MS = 60_000 // 60s - includes cogit pull + merge
export const TRANSPORT_PING_INTERVAL_MS = 5000 // 5s ping - reasonable for local communication
export const TRANSPORT_PING_TIMEOUT_MS = 10_000 // 10s timeout - avoid false disconnects during GC/load

// LLM Model defaults
export const DEFAULT_LLM_MODEL = 'gemini-3-flash-preview'

// Project room naming convention
export const PROJECT_ROOM_PREFIX = 'project:'
export const PROJECT_ROOM_SUFFIX = ':broadcast'

// === Daemon infrastructure constants ===
export const GLOBAL_PROJECTS_DIR = 'projects'
export const REGISTRY_FILE = 'registry.json'
export const DYNAMIC_PORT_MIN = 49_152
export const DYNAMIC_PORT_MAX = 65_535
export const PORT_BATCH_SIZE = 20
export const PORT_MAX_ATTEMPTS = 5
// Web UI (stable port, separate from dynamic transport port)
export const WEBUI_DEFAULT_PORT = 7700
export const WEBUI_STATE_FILE = 'webui.json'
// Heartbeat
export const HEARTBEAT_FILE = 'heartbeat'
export const HEARTBEAT_INTERVAL_MS = 5000 // Write every 5s

// === Idle timeout (server daemon shutdown) ===

/** Server idle timeout - daemon shuts down after this period of no clients */
export const SERVER_IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

// === Agent idle timeout (agent process cleanup) ===

/** Agent idle timeout - kill agent after this period of no task execution */
export const AGENT_IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

/** Agent idle check interval - how often to check for idle agents */
export const AGENT_IDLE_CHECK_INTERVAL_MS = 10_000 // Check every 10s (responsive)

// Sleep/wake detection
export const SLEEP_WAKE_CHECK_INTERVAL_MS = 5000
export const SLEEP_WAKE_THRESHOLD_MULTIPLIER = 3

// Spawn lock, daemon readiness polling, daemon stop budget
// → moved to @campfirein/brv-transport-client

// Shutdown
export const TRANSPORT_STOP_TIMEOUT_MS = 3000 // 3s max for transport server to stop
export const SHUTDOWN_FORCE_EXIT_MS = 5000 // 5s safety net before force exit

// Auth state polling (daemon)
export const AUTH_STATE_POLL_INTERVAL_MS = 5000 // Poll token store every 5s

// Agent Pool (T6)
export const AGENT_MAX_CONCURRENT_TASKS = 5 // Max parallel curate/query tasks per agent process
export const AGENT_POOL_MAX_SIZE = 10
export const AGENT_PROCESS_READY_TIMEOUT_MS = 30_000 // 30s max wait for child process to register
export const AGENT_PROCESS_STOP_TIMEOUT_MS = 5000 // 5s max wait for child process to stop gracefully

// Curate log
export const CURATE_LOG_DIR = 'curate-log'
export const CURATE_LOG_ID_PREFIX = 'cur'

// Query log
export const QUERY_LOG_DIR = 'query-log'
export const QUERY_LOG_ID_PREFIX = 'qry'
// Dream log
export const DREAM_LOG_DIR = 'dream-log'
export const DREAM_LOG_ID_PREFIX = 'drm'

// Task history (per-project on-disk task journal — see M2 milestone)
export const TASK_HISTORY_DIR = 'task-history'
export const TASK_HISTORY_ID_PREFIX = 'tsk'
// Age-based prune is disabled by default. Task history is a business artifact
// (audit/review), not a log — count-based rotation is the sole retention policy.
// Override per-store via `maxAgeDays` constructor option if a deployment ever
// needs time-based eviction.
export const TASK_HISTORY_DEFAULT_MAX_AGE_DAYS = 0
export const TASK_HISTORY_DEFAULT_MAX_ENTRIES = 1000
export const TASK_HISTORY_DEFAULT_MAX_INDEX_BLOAT_RATIO = 2
export const TASK_HISTORY_STALE_THRESHOLD_MS = 600_000

// Review backups (stores pre-curate file content for local HITL review diffs)
export const REVIEW_BACKUPS_DIR = 'review-backups'

// User-configurable operational settings (global, restart-required)
export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_SCHEMA_VERSION = '1'

// Default wall-clock budget for the agentic loop (`llm.iterationBudgetMs`).
// Slow local-LLM users override via `brv settings set llm.iterationBudgetMs <ms>`.
export const AGENT_LLM_ITERATION_BUDGET_MS = 600_000 // 10 minutes

// Default per-request HTTP timeout for direct LLM provider calls
// (`llm.requestTimeoutMs`). A hung Ollama/LM Studio connection aborts at this
// boundary; the retry layer treats the abort as a transient error.
export const AGENT_LLM_REQUEST_TIMEOUT_MS = 120_000 // 2 minutes

// Per-task heartbeat interval. The task router fires `TaskEvents.HEARTBEAT`
// after this much quiet time so the CLI can distinguish "task is slow but
// progressing" from "daemon is stuck". Reset by any other task-scoped
// emission. Internal constant — not user-configurable in M6.
export const TASK_HEARTBEAT_INTERVAL_MS = 10_000 // 10 seconds
// === Hierarchical DAG (summary, archive, manifest) ===
export const SUMMARY_INDEX_FILE = '_index.md'
export const ARCHIVE_DIR = '_archived'
export const STUB_EXTENSION = '.stub.md'
export const FULL_ARCHIVE_EXTENSION = '.full.md'
export const ABSTRACT_EXTENSION = '.abstract.md'
export const OVERVIEW_EXTENSION = '.overview.md'
export const MANIFEST_FILE = '_manifest.json'
export const ARCHIVE_IMPORTANCE_THRESHOLD = 35
export const DEFAULT_GHOST_CUE_MAX_TOKENS = 220

/** Patterns the context-tree .gitignore must contain. */
export const CONTEXT_TREE_GITIGNORE_PATTERNS = [
  // Derived artifacts
  '.gitignore',
  '.snapshot.json',
  '_manifest.json',
  '_index.md',
  '*.abstract.md',
  '*.overview.md',

  // macOS
  '.DS_Store',
  '._*',

  // Windows
  'Thumbs.db',
  'ehthumbs.db',
  'Desktop.ini',

  // Linux
  '.directory',
  '.fuse_hidden*',
  '.nfs*',

  // Editor swap / backup / temp
  '*.swp',
  '*.swo',
  '*~',
  '.#*',
  '*.bak',
  '*.tmp',
]

export const CONTEXT_TREE_GITIGNORE_HEADER = '# Derived artifacts — do not track'
