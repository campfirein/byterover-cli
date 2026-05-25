#!/bin/sh
# openclaw-setup.sh — ByteRover Integration Installer for OpenClaw
# Usage: curl -fsSL https://storage.googleapis.com/brv-releases/openclaw-setup.sh | sh
#
# Configures ByteRover as long-term memory for OpenClaw agents:
#   - Automatic Memory Flush (context compaction)
#   - ByteRover Context Plugin (hook-based injection)
#   - Workspace protocol updates (AGENTS.md, TOOLS.md)

set -eu

# ─── Constants ────────────────────────────────────────────────────────────────

CONFIG_PATH="$HOME/.openclaw/openclaw.json"

# ─── Colors (respects NO_COLOR and non-terminal) ─────────────────────────────

if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  DIM=''
  GREEN=''
  YELLOW=''
  RED=''
  BLUE=''
  RESET=''
else
  DIM='\033[2m'
  GREEN='\033[32m'
  YELLOW='\033[1;33m'
  RED='\033[31m'
  BLUE='\033[34m'
  RESET='\033[0m'
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

info() {
  printf "${BLUE}%s${RESET}\n" "$1"
}

success() {
  printf "${GREEN}[ok] %s${RESET}\n" "$1"
}

warn() {
  printf "${YELLOW}[!] %s${RESET}\n" "$1" >&2
}

error() {
  printf "${RED}[X] %b${RESET}\n" "$1" >&2
  exit 1
}

confirm() {
  printf "%s (y/N): " "$1"
  if [ -t 0 ]; then
    read -r answer
  else
    read -r answer < /dev/tty
  fi
  case "${answer:-}" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

retry_with_backoff() {
  local max_retries=3
  local delay=5
  local attempt=1

  while [ "$attempt" -le "$max_retries" ]; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -lt "$max_retries" ]; then
      warn "Attempt $attempt/$max_retries failed. Retrying in ${delay}s..."
      sleep "$delay"
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

setup_cleanup() {
  CLEANUP_FILES=""
  CONFIG_BACKUP=""
  cleanup() {
    local exit_code=$?
    if [ -n "$CLEANUP_FILES" ]; then
      # shellcheck disable=SC2086
      rm -f $CLEANUP_FILES
    fi
    if [ "$exit_code" -ne 0 ] && [ -n "$CONFIG_BACKUP" ] && [ -f "$CONFIG_BACKUP" ]; then
      printf "${YELLOW}[!] Installation failed. Restoring config from backup...${RESET}\n" >&2
      cp "$CONFIG_BACKUP" "$CONFIG_PATH"
      printf "${GREEN}[ok] Config restored from %s${RESET}\n" "$CONFIG_BACKUP" >&2
    fi
  }
  trap cleanup EXIT
}

# ─── Pre-flight Checks ───────────────────────────────────────────────────────

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    error "Node is missing. Node.js is required to run this installer."
  fi

  local node_major
  node_major=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null) || node_major=0
  if [ "$node_major" -lt 14 ]; then
    error "Node.js 14+ is required (found v$(node -v 2>/dev/null || echo unknown)). Please upgrade."
  fi
  local node_ver
  node_ver=$(node -v 2>/dev/null)
  success "Node is installed (${node_ver#v})"
}

setup_brv_openclaw_integration() {
  local global_skills_dir="$HOME/.openclaw/skills"

  [ -n "${BRV_CMD:-}" ] || error "BRV_CMD is not set. Run check_brv_cli() first."

  # Step 1: Install ByteRover skill into OpenClaw's global skills directory
  if [ -d "$global_skills_dir/byterover" ] && [ -f "$global_skills_dir/byterover/SKILL.md" ]; then
    success "ByteRover Skill is already installed at $global_skills_dir/byterover"
  else
    info "Installing ByteRover Skill into $global_skills_dir..."
    if ! retry_with_backoff npx clawhub@latest install byterover --force; then
      error "Failed to install ByteRover Skill after multiple attempts."
    fi
  fi

  # Step 2: Register OpenClaw as a skill-type connector inside ByteRover (idempotent)
  info "Registering OpenClaw connector in ByteRover..."
  if ! "$BRV_CMD" connectors install OpenClaw --type skill; then
    error "Failed to register OpenClaw connector in ByteRover."
  fi
  success "ByteRover <-> OpenClaw integration is configured"
}

check_brv_cli() {
  # Resolve brv binary path — needed for non-interactive processes (Docker, systemd, cron)
  # that don't source shell configs like .bashrc/.profile.
  if command -v brv >/dev/null 2>&1; then
    BRV_CMD="$(command -v brv)"
  elif [ -x "$HOME/.brv-cli/bin/brv" ]; then
    BRV_CMD="$HOME/.brv-cli/bin/brv"
  elif [ -x "/usr/local/bin/brv" ]; then
    BRV_CMD="/usr/local/bin/brv"
  else
    info "ByteRover CLI not found. Installing from https://byterover.dev/install.sh..."
    if curl -fsSL https://byterover.dev/install.sh | sh; then
      BRV_CMD="$HOME/.brv-cli/bin/brv"
    else
      error "Failed to install ByteRover CLI. Please install it manually: curl -fsSL https://byterover.dev/install.sh | sh"
    fi
  fi

  if [ ! -x "$BRV_CMD" ]; then
    error "ByteRover CLI binary not found at $BRV_CMD after installation."
  fi
  success "ByteRover-cli found at $BRV_CMD"
}

check_openclaw_cli() {
  if command -v openclaw >/dev/null 2>&1; then
    success "OpenClaw CLI is installed"
  else
    error "OpenClaw CLI is missing. Cannot schedule OpenClaw cron jobs."
  fi
}

check_config() {
  if [ ! -f "$CONFIG_PATH" ]; then
    error "Config file not found at $CONFIG_PATH. Please install openclaw first (https://docs.openclaw.ai/install#npm-pnpm) to generate the configuration."
  fi

  if ! CONFIG_PATH="$CONFIG_PATH" node -e 'JSON.parse(require("fs").readFileSync(process.env.CONFIG_PATH, "utf8"))' 2>/dev/null; then
    error "Config file at $CONFIG_PATH is not valid JSON."
  fi

  success "Config file is valid"
}

# ─── Storage Setup ────────────────────────────────────────────────────────────

backup_config() {
  CONFIG_BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  # Use restrictive umask — config may contain API keys or tokens
  (umask 0077; cp "$CONFIG_PATH" "$CONFIG_BACKUP")
  echo "Backed up config to $CONFIG_BACKUP"
}

# ─── Config Patching (Node.js) ───────────────────────────────────────────────

patch_memory_flush_config() {
  FLUSH_SYSTEM_PROMPT="$1" FLUSH_PROMPT="$2" CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    const systemPrompt = process.env.FLUSH_SYSTEM_PROMPT;
    const prompt = process.env.FLUSH_PROMPT;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

        config.agents = config.agents || {};
        config.agents.defaults = config.agents.defaults || {};
        config.agents.defaults.compaction = config.agents.defaults.compaction || {};

        config.agents.defaults.compaction.reserveTokensFloor = 50000;
        config.agents.defaults.compaction.memoryFlush = {
            enabled: true,
            softThresholdTokens: 4000,
            systemPrompt: systemPrompt,
            prompt: prompt
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log("Config updated successfully.");
    } catch (e) {
        console.error("Failed to patch config:", e);
        process.exit(1);
    }
  '
}

remove_memory_flush_config() {
  CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const compaction = config.agents?.defaults?.compaction;
        if (!compaction) { console.log("No memory flush config found."); process.exit(0); }
        let changed = false;
        if (compaction.memoryFlush) { delete compaction.memoryFlush; changed = true; }
        if (compaction.reserveTokensFloor) { delete compaction.reserveTokensFloor; changed = true; }
        if (Object.keys(compaction).length === 0) delete config.agents.defaults.compaction;
        if (changed) {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            console.log("Memory flush config removed.");
        } else {
            console.log("No memory flush config found.");
        }
    } catch (e) {
        console.error("Failed to remove memory flush config:", e);
        process.exit(1);
    }
  '
}

list_workspaces() {
  CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    try {
        const config = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
        const ws = new Set();
        if (config.agents?.defaults?.workspace) ws.add(config.agents.defaults.workspace);
        if (Array.isArray(config.agents?.list)) {
            config.agents.list.forEach(a => { if (a.workspace) ws.add(a.workspace); });
        }
        console.log(Array.from(ws).join("\n"));
    } catch (e) { process.exit(0); }
  '
}

# ─── Feature: Memory Flush ───────────────────────────────────────────────────

configure_memory_flush() {
  printf "${YELLOW}Feature: Automatic Memory Flush${RESET}\n"
  echo "Automatically curates insights to ByteRover when the context window fills up."

  if confirm "Enable Automatic Memory Flush?"; then
    echo "Patching $CONFIG_PATH..."

    local system_prompt="Session nearing compaction. Store durable memories now."
    local prompt="Review the session for any architectural decisions, bug fixes, or new patterns. If found, run '${BRV_CMD} curate \"<summary of change>\"' to update the context tree. Also write personal notes to memory/YYYY-MM-DD.md. Reply NO_REPLY if nothing to store."

    patch_memory_flush_config "$system_prompt" "$prompt"
    success "openclaw.json updated."
  else
    echo "Disabling Memory Flush..."
    remove_memory_flush_config
  fi
  echo ""
}

# ─── Feature: ByteRover Context Plugin ───────────────────────────────────────

verify_plugin_installed() {
  local plugin_id="$1"
  openclaw plugins list 2>/dev/null | grep -qw "$plugin_id"
}

ensure_plugin_active() {
  local plugin_list
  plugin_list=$(openclaw plugins list 2>/dev/null) || plugin_list=""
  if ! echo "$plugin_list" | grep -qw "byterover"; then
    warn "No ByteRover plugin appears to be active."
    warn "Run 'openclaw plugins list' to check status, or 'openclaw plugins doctor' to diagnose."
  fi
}

remove_existing_byterover_plugin() {
  # Remove CLI-installed plugin
  openclaw plugins uninstall byterover --force 2>/dev/null || true
  # Remove old local plugin files (legacy manual install)
  rm -rf "$HOME/.openclaw/extensions/byterover"
  # Clean up config entries
  openclaw config unset plugins.slots.contextEngine 2>/dev/null || true
  CONFIG_PATH="$CONFIG_PATH" node -e '
    const fs = require("fs");
    const configPath = process.env.CONFIG_PATH;
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const entries = config.plugins?.entries;
        if (entries && entries["byterover"]) delete entries["byterover"];
        if (Array.isArray(config.plugins?.load?.paths)) {
            config.plugins.load.paths = config.plugins.load.paths.filter(p => p !== "~/.openclaw/extensions/byterover");
            if (config.plugins.load.paths.length === 0) delete config.plugins.load.paths;
            if (config.plugins.load && Object.keys(config.plugins.load).length === 0) delete config.plugins.load;
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch(e) { process.stderr.write("[byterover] cleanup config warning: " + e.message + "\n"); }
  ' 2>/dev/null || true
}

configure_context_plugin() {
  printf "${YELLOW}Feature: ByteRover Context Engine - Intelligent Automated Memory Curation and Memory Retrieval${RESET}\n"
  echo "Installs the ByteRover Context Engine plugin for injecting ByteRover memory context into prompts and automatically curate insights."

  # Requires OpenClaw v2026.3.22+
  local MIN_OPENCLAW_VERSION="2026.3.22"
  local openclaw_version
  openclaw_version=$(openclaw -v 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1) || openclaw_version=""

  if [ -z "$openclaw_version" ]; then
    warn "Could not detect OpenClaw version. Skipping Context Plugin setup."
    echo ""
    return
  fi

  local cur_year cur_month cur_day min_year min_month min_day
  cur_year=$(echo "$openclaw_version" | cut -d. -f1)
  cur_month=$(echo "$openclaw_version" | cut -d. -f2)
  cur_day=$(echo "$openclaw_version" | cut -d. -f3)
  min_year=$(echo "$MIN_OPENCLAW_VERSION" | cut -d. -f1)
  min_month=$(echo "$MIN_OPENCLAW_VERSION" | cut -d. -f2)
  min_day=$(echo "$MIN_OPENCLAW_VERSION" | cut -d. -f3)

  local version_ok=true
  if [ "$cur_year" -lt "$min_year" ] 2>/dev/null; then
    version_ok=false
  elif [ "$cur_year" -eq "$min_year" ] 2>/dev/null; then
    if [ "$cur_month" -lt "$min_month" ] 2>/dev/null; then
      version_ok=false
    elif [ "$cur_month" -eq "$min_month" ] 2>/dev/null; then
      if [ "$cur_day" -lt "$min_day" ] 2>/dev/null; then
        version_ok=false
      fi
    fi
  fi

  if [ "$version_ok" = false ]; then
    warn "OpenClaw v${MIN_OPENCLAW_VERSION}+ is required for Context Plugin (found v${openclaw_version}). Please upgrade: npm i openclaw@latest -g"
    echo ""
    return
  fi

  if ! confirm "Install ByteRover Context Plugin?"; then
    echo "Uninstalling ByteRover Context Plugin..."
    remove_existing_byterover_plugin
    echo ""
    return
  fi

  # Clean slate: remove old local files + previous CLI install to avoid conflicts
  remove_existing_byterover_plugin

  info "Installing @byterover/byterover plugin..."
  if ! retry_with_backoff openclaw plugins install @byterover/byterover@latest; then
    error "Failed to install @byterover/byterover plugin after multiple attempts."
  fi
  success "Plugin installed."

  # Enable, trust, and assign to contextEngine slot
  openclaw plugins enable byterover || warn "Could not enable plugin — run: openclaw plugins enable byterover"
  openclaw config set plugins.slots.contextEngine byterover || warn "Could not set contextEngine slot — run: openclaw config set plugins.slots.contextEngine byterover"

  # Always configure the resolved brv path so the plugin doesn't need to re-search at runtime
  openclaw config set plugins.entries.byterover.config.brvPath "$BRV_CMD" || true
  # Set cwd to the openclaw workspace so the plugin runs in the correct directory
  openclaw config set plugins.entries.byterover.config.cwd "$HOME/.openclaw/workspace" || true

  # Verify installation
  if ! verify_plugin_installed "byterover"; then
    warn "Plugin verification failed. Run 'openclaw plugins doctor' to diagnose."
  fi

  success "ByteRover Context Plugin enabled."
  echo ""
}

# ─── Workspace Protocol Updates ───────────────────────────────────────────────

update_agents_md() {
  local agents_md="$1"

  if [ ! -f "$agents_md" ]; then
    warn "AGENTS.md not found in $(dirname "$agents_md"). Skipping."
    return
  fi

  # Remove old Knowledge Protocol section if present (may have stale brv path)
  # Uses Node.js instead of sed for cross-platform compatibility (BSD/busybox sed differ)
  if grep -q "Knowledge Protocol" "$agents_md"; then
    MDFILE="$agents_md" node -e '
      const fs = require("fs");
      const f = process.env.MDFILE;
      let t = fs.readFileSync(f, "utf8");
      t = t.replace(/\n*## Knowledge Protocol \(ByteRover\)[\s\S]*?(?=\n## |\s*$)/, "");
      fs.writeFileSync(f, t.replace(/\s+$/, "\n"));
    '
  fi

  cat >> "$agents_md" <<AGENTS_EOF

## Knowledge Protocol (ByteRover)
This agent uses ByteRover (\`brv\`) as its long-term structured memory.
You MUST use this for gathering contexts before any work. This is a Knowledge management for AI agents. Use \`brv\` to store and retrieve project patterns, decisions, and architectural rules in .brv/context-tree.
1.  **Start:** Before answering questions, run \`${BRV_CMD} query "<topic>"\` to load existing patterns.
2.  **Finish:** After completing a task, run \`${BRV_CMD} curate "<summary>"\` to save knowledge.
3.  **Don't Guess:** If you don't know anything, query it first.
4.  **Response Format:** When using knowledge, optionally cite it or mention storage:
    - "Based on brv contexts at \`.brv/context-trees/...\` and my research..."
    - "I also stored successfully knowledge to brv context-tree."
AGENTS_EOF
  success "Updated $agents_md"
}

update_tools_md() {
  local tools_md="$1"

  if [ ! -f "$tools_md" ]; then
    warn "TOOLS.md not found in $(dirname "$tools_md"). Skipping."
    return
  fi

  # Remove old ByteRover section if present (may have stale brv path)
  # Uses Node.js instead of sed for cross-platform compatibility (BSD/busybox sed differ)
  if grep -q "ByteRover (Memory)" "$tools_md"; then
    MDFILE="$tools_md" node -e '
      const fs = require("fs");
      const f = process.env.MDFILE;
      let t = fs.readFileSync(f, "utf8");
      t = t.replace(/\n*## ByteRover \(Memory\)[\s\S]*?(?=\n## |\s*$)/, "");
      fs.writeFileSync(f, t.replace(/\s+$/, "\n"));
    '
  fi

  cat >> "$tools_md" <<TOOLS_EOF

## ByteRover (Memory)
- **Query:** \`${BRV_CMD} query "auth patterns"\` (Check existing knowledge)
- **Curate:** \`${BRV_CMD} curate "Auth uses JWT in cookies"\` (Save new knowledge)
- **Sync:** \`${BRV_CMD} pull\` / \`${BRV_CMD} push\` (Sync with team - requires login)
TOOLS_EOF
  success "Updated $tools_md"
}

restart_openclaw_gateway() {
  echo "Restarting OpenClaw gateway to apply changes..."
  openclaw gateway stop 2>/dev/null || true
  if openclaw gateway install; then
    if openclaw gateway start; then
      success "OpenClaw gateway restarted."
    else
      warn "Failed to restart OpenClaw gateway. Run 'openclaw gateway install' manually."
    fi
  else
    warn "Failed to restart OpenClaw gateway. Run 'openclaw gateway install' manually."
  fi
}

update_workspace_protocols() {
  info "Phase 3: Updating Protocols"

  local workspaces
  workspaces=$(list_workspaces)

  if [ -z "$workspaces" ]; then
    warn "No agent workspaces found in config. Skipping workspace protocol updates."
  else
    echo "$workspaces" | while IFS= read -r ws; do
      [ -z "$ws" ] && continue

      # Expand tilde if present
      case "$ws" in
        "~")   ws="$HOME" ;;
        "~"/*) ws="$HOME${ws#"~"}" ;;
      esac

      if [ ! -d "$ws" ]; then
        warn "Workspace directory not found: $ws. Skipping."
        continue
      fi

      printf "Updating workspace: ${GREEN}%s${RESET}\n" "$ws"
      update_agents_md "$ws/AGENTS.md"
      update_tools_md "$ws/TOOLS.md"
    done
  fi

  # Always restart gateway so newly installed plugins are loaded
  restart_openclaw_gateway
}

# ─── Fix Ownership (root-install safe) ────────────────────────────────────────
# When install.sh + openclaw-setup.sh run as root (common in Docker), many
# directories under $HOME are created owned by root. But the runtime process
# (e.g. OpenClaw gateway) runs as a non-root user (e.g. "node"). This function
# recursively fixes ownership on ALL known directories so brv, oclif, npm, and
# clawhub can write at runtime.

fix_ownership() {
  # Only relevant when running as root
  [ "$(id -u)" -eq 0 ] || return 0

  # Determine the actual runtime user (the owner of $HOME)
  local home_owner
  home_owner="$(stat -c '%u:%g' "$HOME" 2>/dev/null || stat -f '%u:%g' "$HOME" 2>/dev/null)" || return 0

  # If $HOME is owned by root, nothing to fix
  [ "$home_owner" != "0:0" ] || return 0

  info "Fixing file ownership for non-root runtime user..."

  # Recursively fix only the specific directories that root-install creates.
  # install.sh creates:        ~/.brv-cli, ~/.npm-global, ~/.npm, ~/.cache/brv
  # openclaw-setup.sh creates: ~/.openclaw/*, ~/.config/clawhub
  # oclif/npm create:          ~/.config/configstore, ~/.local/state/brv
  for dir in \
    "$HOME/.brv-cli" \
    "$HOME/.openclaw" \
    "$HOME/.config/clawhub" \
    "$HOME/.config/configstore" \
    "$HOME/.local/state/brv" \
    "$HOME/.cache/brv" \
    "$HOME/.npm" \
    "$HOME/.npm-global"; do
    [ -d "$dir" ] || continue
    chown -R "$home_owner" "$dir" 2>/dev/null && \
      printf "  ${DIM}Fixed: %s${RESET}\n" "$dir" || \
      warn "Could not fix ownership of $dir"
  done

  # Fix parent traversal (non-recursive) so runtime user can reach subdirectories
  for parent in "$HOME/.config" "$HOME/.local" "$HOME/.local/state" "$HOME/.cache"; do
    [ -d "$parent" ] && chown "$home_owner" "$parent" 2>/dev/null
  done

  # macOS: oclif also uses ~/Library/Application Support/brv
  if [ "$(uname -s)" = "Darwin" ]; then
    for dir in "$HOME/Library" "$HOME/Library/Application Support"; do
      [ -d "$dir" ] || continue
      chown -R "$home_owner" "$dir/brv" 2>/dev/null
      # Fix parent traversal (non-recursive)
      chown "$home_owner" "$dir" 2>/dev/null
    done
  fi
}

# ─── Output ───────────────────────────────────────────────────────────────────

print_success() {
  echo ""
  success "=== Installation Complete ==="
  echo "Your agent is now integrated with ByteRover."
  echo ""
  printf "${YELLOW}Next step: Connect an LLM provider${RESET}\n"
  echo "ByteRover needs an LLM provider to power its agent features."
  echo "Run one of the following to get started:"
  echo ""
  echo "  brv providers connect byterover                                # Free, requires login with ByteRover account"
  echo "  brv providers connect openai --api-key sk-xxx --model gpt-4.1  # Requires OpenAI API key"
  echo "  brv providers connect <llm-provider>                           # Requires 3rd API key"
  echo ""
  echo "To see all available providers:  brv providers list"
  echo ""
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  setup_cleanup

  info "=== ByteRover Integration Installer ==="
  echo "This script configures ByteRover as your openclaw's long-term memory."
  echo ""

  # Phase 1: Pre-flight Checks
  info "Phase 1: Pre-flight Checks"
  check_node
  check_brv_cli
  setup_brv_openclaw_integration
  check_openclaw_cli
  check_config
  echo ""

  # Phase 1.1: Storage & Backup
  backup_config
  echo ""

  # Phase 2: Configuration
  info "Phase 2: Configuration"
  info "--- Query Story Options ---"
  configure_context_plugin
  info "--- Curate Story Options ---"
  configure_memory_flush

  ensure_plugin_active

  # Phase 3: Workspace Updates
  update_workspace_protocols
  echo ""

  # Phase 4: Fix ownership (when running as root in Docker)
  fix_ownership

  print_success
}

main "$@"
