#!/bin/bash
# prjct statusline - Cache utilities
# Optimized caching for fast statusline rendering

# Cache directory
CACHE_DIR="/tmp/prjct_statusline"

# Ensure cache directory exists
ensure_cache_dir() {
  [[ -d "$CACHE_DIR" ]] || mkdir -p "$CACHE_DIR"
}

# Check if cache file is still valid
# Usage: cache_valid "/path/to/cache" 30
# Returns: 0 if valid, 1 if expired/missing
cache_valid() {
  local file="$1"
  local ttl="${2:-30}"

  [[ ! -f "$file" ]] && return 1

  # Get file age in seconds (macOS and Linux compatible)
  local mtime
  if [[ "$OSTYPE" == "darwin"* ]]; then
    mtime=$(stat -f %m "$file" 2>/dev/null)
  else
    mtime=$(stat -c %Y "$file" 2>/dev/null)
  fi

  [[ -z "$mtime" ]] && return 1

  local now=$(date +%s)
  local age=$((now - mtime))

  [[ "$age" -lt "$ttl" ]]
}

# Read from cache if valid, otherwise return empty
# Usage: result=$(read_cache "/path/to/cache" 30)
read_cache() {
  local file="$1"
  local ttl="${2:-30}"

  if cache_valid "$file" "$ttl"; then
    cat "$file"
  fi
}

# Write to cache
# Usage: write_cache "/path/to/cache" "content"
write_cache() {
  local file="$1"
  local content="$2"

  ensure_cache_dir
  echo "$content" > "$file"
}

# Parse all stdin data in a single jq call
# Sets global variables: MODEL, CWD, ADDED, REMOVED, CTX_SIZE, INPUT_TOKENS, etc.
parse_stdin() {
  local input="$1"

  # Single jq call to extract all values
  local parsed
  parsed=$(echo "$input" | jq -r '
    def pct:
      (.used_percentage // .usedPercent // .used_percent // .percent // empty);
    def reset:
      (.resets_at // .resetsAt // .reset_at // .resetAt // empty);
    def key:
      (.id // .name // .limit_name // .limitName // .window // .type // .label // "" | tostring | ascii_downcase);
    def normpct:
      if . == null or . == "" then "" else (tonumber | floor | tostring) end;
    def blank_to_dash:
      if . == null or . == "" then "-" else . end;
    def five_hour_from($rl):
      if ($rl | type) == "array" then
        (($rl[]? | select((key | test("5|five|hour")) and ((key | test("week|7|day")) | not)) | pct) // "")
      elif ($rl | type) == "object" then
        (($rl.five_hour | pct) // ($rl.fiveHour | pct) // ($rl["5h"] | pct) // ($rl.primary | pct) //
          ($rl | to_entries[]? | select(((.key | ascii_downcase) | test("5|five|hour")) or ((.value | key) | test("5|five|hour"))) | .value | pct) // "")
      else "" end;
    def weekly_from($rl):
      if ($rl | type) == "array" then
        (($rl[]? | select(key | test("week|weekly|7|day")) | pct) // "")
      elif ($rl | type) == "object" then
        (($rl.weekly | pct) // ($rl.week | pct) // ($rl.seven_day | pct) // ($rl.sevenDay | pct) // ($rl["7d"] | pct) // ($rl.secondary | pct) //
          ($rl | to_entries[]? | select(((.key | ascii_downcase) | test("week|weekly|7|day")) or ((.value | key) | test("week|weekly|7|day"))) | .value | pct) // "")
      else "" end;
    def five_hour_reset_from($rl):
      if ($rl | type) == "array" then
        (($rl[]? | select((key | test("5|five|hour")) and ((key | test("week|7|day")) | not)) | reset) // "")
      elif ($rl | type) == "object" then
        (($rl.five_hour | reset) // ($rl.fiveHour | reset) // ($rl["5h"] | reset) // ($rl.primary | reset) //
          ($rl | to_entries[]? | select(((.key | ascii_downcase) | test("5|five|hour")) or ((.value | key) | test("5|five|hour"))) | .value | reset) // "")
      else "" end;
    def weekly_reset_from($rl):
      if ($rl | type) == "array" then
        (($rl[]? | select(key | test("week|weekly|7|day")) | reset) // "")
      elif ($rl | type) == "object" then
        (($rl.weekly | reset) // ($rl.week | reset) // ($rl.seven_day | reset) // ($rl.sevenDay | reset) // ($rl["7d"] | reset) // ($rl.secondary | reset) //
          ($rl | to_entries[]? | select(((.key | ascii_downcase) | test("week|weekly|7|day")) or ((.value | key) | test("week|weekly|7|day"))) | .value | reset) // "")
      else "" end;
    .rate_limits as $rl |
    # Two host payload shapes: Claude Code nested objects (primary), and
    # Kimi Code'\''s flat snapshot ({model: "...", cwd, contextTokens,
    # maxContextTokens} — see [status_line].command in ~/.kimi-code/tui.toml).
    [
      ((.model | if type == "object" then .display_name else . end) // "Claude"),
      (.workspace.current_dir // .cwd // "~"),
      (.cost.total_lines_added // 0),
      (.cost.total_lines_removed // 0),
      (.context_window.context_window_size // .maxContextTokens // 200000),
      (.context_window.current_usage.input_tokens // .contextTokens // 0),
      (.context_window.current_usage.cache_creation_input_tokens // 0),
      (.context_window.current_usage.cache_read_input_tokens // 0),
      (five_hour_from($rl) | normpct | blank_to_dash),
      (five_hour_reset_from($rl) // "" | blank_to_dash),
      (weekly_from($rl) | normpct | blank_to_dash),
      (weekly_reset_from($rl) // "" | blank_to_dash)
    ] | @tsv
  ' 2>/dev/null)

  # Parse tab-separated values (save/restore IFS to avoid breaking associative arrays)
  # Tab is IFS whitespace, so bash collapses runs of tabs — an empty middle
  # field would shift every later field one slot left. The jq side emits "-"
  # for blank limit fields (blank_to_dash); map the sentinel back after read.
  local old_ifs="$IFS"
  IFS=$'\t' read -r MODEL CWD ADDED REMOVED CTX_SIZE INPUT_TOKENS CACHE_CREATE CACHE_READ RATE_LIMIT_5H_PERCENT RATE_LIMIT_5H_RESET RATE_LIMIT_WEEKLY_PERCENT RATE_LIMIT_WEEKLY_RESET <<< "$parsed"
  IFS="$old_ifs"
  [[ "$RATE_LIMIT_5H_PERCENT" == "-" ]] && RATE_LIMIT_5H_PERCENT=""
  [[ "$RATE_LIMIT_5H_RESET" == "-" ]] && RATE_LIMIT_5H_RESET=""
  [[ "$RATE_LIMIT_WEEKLY_PERCENT" == "-" ]] && RATE_LIMIT_WEEKLY_PERCENT=""
  [[ "$RATE_LIMIT_WEEKLY_RESET" == "-" ]] && RATE_LIMIT_WEEKLY_RESET=""

  # Set defaults if parsing failed
  MODEL="${MODEL:-Claude}"
  CWD="${CWD:-~}"
  ADDED="${ADDED:-0}"
  REMOVED="${REMOVED:-0}"
  CTX_SIZE="${CTX_SIZE:-200000}"
  INPUT_TOKENS="${INPUT_TOKENS:-0}"
  CACHE_CREATE="${CACHE_CREATE:-0}"
  CACHE_READ="${CACHE_READ:-0}"
  RATE_LIMIT_5H_PERCENT="${RATE_LIMIT_5H_PERCENT:-}"
  RATE_LIMIT_5H_RESET="${RATE_LIMIT_5H_RESET:-}"
  RATE_LIMIT_WEEKLY_PERCENT="${RATE_LIMIT_WEEKLY_PERCENT:-}"
  RATE_LIMIT_WEEKLY_RESET="${RATE_LIMIT_WEEKLY_RESET:-}"

  # Calculate context percentage
  TOTAL_USED=$((INPUT_TOKENS + CACHE_CREATE + CACHE_READ))
  if [[ "$CTX_SIZE" -gt 0 ]] 2>/dev/null; then
    CTX_PERCENT=$((TOTAL_USED * 100 / CTX_SIZE))
  else
    CTX_PERCENT=0
  fi
  [[ "$CTX_PERCENT" -gt 100 ]] && CTX_PERCENT=100
  [[ "$CTX_PERCENT" -lt 0 ]] && CTX_PERCENT=0
}

# Get project ID from .prjct/prjct.config.json
# Usage: project_id=$(get_project_id)
get_project_id() {
  local config_file="${CWD}/.prjct/prjct.config.json"

  [[ ! -f "$config_file" ]] && return

  jq -r '.projectId // ""' "$config_file" 2>/dev/null
}

# Get global path for project storage
# Usage: global_path=$(get_global_path "project-id")
get_global_path() {
  local project_id="$1"
  [[ -z "$project_id" ]] && return
  echo "${HOME}/.prjct-cli/projects/${project_id}"
}

