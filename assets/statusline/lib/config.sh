#!/bin/bash
# prjct statusline - Configuration loading utilities
# Loads user preferences for statusline customization

# Config file location
CONFIG_FILE="${HOME}/.prjct-cli/statusline/config.json"

# Default configuration values
DEFAULT_THEME="default"
DEFAULT_CACHE_TTL_PRJCT=30
DEFAULT_CACHE_TTL_GIT=5
DEFAULT_CACHE_TTL_LINEAR=60
DEFAULT_CACHE_TTL_JIRA=60
DEFAULT_TASK_MAX_LENGTH=25
DEFAULT_CONTEXT_MIN_PERCENT=30
DEFAULT_ENRICHMENT_ENABLED="true"

# Component configuration (will be populated by load_config)
declare -A COMPONENT_ENABLED
declare -A COMPONENT_POSITION

# Load configuration from JSON file
# Sets global CONFIG_* variables
load_config() {
  # Set defaults first
  CONFIG_THEME="$DEFAULT_THEME"
  CONFIG_CACHE_TTL_PRJCT="$DEFAULT_CACHE_TTL_PRJCT"
  CONFIG_CACHE_TTL_GIT="$DEFAULT_CACHE_TTL_GIT"
  CONFIG_CACHE_TTL_LINEAR="$DEFAULT_CACHE_TTL_LINEAR"
  CONFIG_CACHE_TTL_JIRA="$DEFAULT_CACHE_TTL_JIRA"
  CONFIG_TASK_MAX_LENGTH="$DEFAULT_TASK_MAX_LENGTH"
  CONFIG_CONTEXT_MIN_PERCENT="$DEFAULT_CONTEXT_MIN_PERCENT"
  CONFIG_LINEAR_ENABLED="true"
  CONFIG_LINEAR_SHOW_PRIORITY="true"
  CONFIG_JIRA_ENABLED="false"
  CONFIG_JIRA_SHOW_PRIORITY="true"
  CONFIG_JIRA_SHOW_STATUS="false"
  CONFIG_ENRICHMENT_ENABLED="$DEFAULT_ENRICHMENT_ENABLED"

  # Default component configuration
  COMPONENT_ENABLED["prjct_icon"]="true"
  # task reads pre-SQLite state.json (gone since v1.24) — dead until it gets a
  # live data source; default off matches default-config.json.
  COMPONENT_ENABLED["task"]="false"
  COMPONENT_ENABLED["linear"]="true"
  COMPONENT_ENABLED["jira"]="false"
  COMPONENT_ENABLED["dir"]="true"
  COMPONENT_ENABLED["git"]="true"
  COMPONENT_ENABLED["changes"]="true"
  COMPONENT_ENABLED["context"]="true"
  COMPONENT_ENABLED["limits"]="true"
  COMPONENT_ENABLED["model"]="true"

  COMPONENT_POSITION["prjct_icon"]=0
  COMPONENT_POSITION["task"]=1
  COMPONENT_POSITION["linear"]=2
  COMPONENT_POSITION["jira"]=2
  COMPONENT_POSITION["dir"]=3
  COMPONENT_POSITION["git"]=4
  COMPONENT_POSITION["changes"]=5
  COMPONENT_POSITION["context"]=6
  COMPONENT_POSITION["limits"]=7
  COMPONENT_POSITION["model"]=8

  # Load config file if exists
  [[ ! -f "$CONFIG_FILE" ]] && return

  # Parse config in a single jq call
  # Note: Use "if .x == null then default else .x end" for booleans since // treats false as null
  local config_data
  config_data=$(jq -r '
    [
      (.theme // "default"),
      (.cacheTTL.prjct // 30),
      (.cacheTTL.git // 5),
      (.cacheTTL.linear // 60),
      (.cacheTTL.jira // 60),
      (.components.task.maxLength // 25),
      (.components.context.minPercent // 30),
      (if .components.linear.showPriority == null then true else .components.linear.showPriority end),
      (if .components.jira.showPriority == null then true else .components.jira.showPriority end),
      (if .components.jira.showStatus == null then false else .components.jira.showStatus end),
      (if .components.prjct_icon.enabled == null then true else .components.prjct_icon.enabled end),
      (if .components.task.enabled == null then true else .components.task.enabled end),
      (if .components.linear.enabled == null then true else .components.linear.enabled end),
      (if .components.jira.enabled == null then false else .components.jira.enabled end),
      (if .components.dir.enabled == null then true else .components.dir.enabled end),
      (if .components.git.enabled == null then true else .components.git.enabled end),
      (if .components.changes.enabled == null then true else .components.changes.enabled end),
      (if .components.context.enabled == null then true else .components.context.enabled end),
      (if .components.limits.enabled == null then true else .components.limits.enabled end),
      (if .components.model.enabled == null then false else .components.model.enabled end),
      (if .components.enrichment.enabled == null then true else .components.enrichment.enabled end),
      (.components.prjct_icon.position // 0),
      (.components.task.position // 1),
      (.components.linear.position // 2),
      (.components.jira.position // 2),
      (.components.dir.position // 3),
      (.components.git.position // 4),
      (.components.changes.position // 5),
      (.components.context.position // 6),
      (.components.limits.position // 7),
      (.components.model.position // 8)
    ] | @tsv
  ' "$CONFIG_FILE" 2>/dev/null)

  [[ -z "$config_data" ]] && return

  # Parse tab-separated values (save/restore IFS to avoid breaking associative arrays)
  local old_ifs="$IFS"
  IFS=$'\t' read -r \
    CONFIG_THEME \
    CONFIG_CACHE_TTL_PRJCT CONFIG_CACHE_TTL_GIT CONFIG_CACHE_TTL_LINEAR CONFIG_CACHE_TTL_JIRA \
    CONFIG_TASK_MAX_LENGTH CONFIG_CONTEXT_MIN_PERCENT \
    CONFIG_LINEAR_SHOW_PRIORITY CONFIG_JIRA_SHOW_PRIORITY CONFIG_JIRA_SHOW_STATUS \
    E_PRJCT_ICON E_TASK E_LINEAR E_JIRA E_DIR E_GIT E_CHANGES E_CONTEXT E_LIMITS E_MODEL E_ENRICHMENT \
    P_PRJCT_ICON P_TASK P_LINEAR P_JIRA P_DIR P_GIT P_CHANGES P_CONTEXT P_LIMITS P_MODEL \
    <<< "$config_data"
  IFS="$old_ifs"

  # Set component enabled states
  COMPONENT_ENABLED["prjct_icon"]="$E_PRJCT_ICON"
  COMPONENT_ENABLED["task"]="$E_TASK"
  COMPONENT_ENABLED["linear"]="$E_LINEAR"
  COMPONENT_ENABLED["jira"]="$E_JIRA"
  COMPONENT_ENABLED["dir"]="$E_DIR"
  COMPONENT_ENABLED["git"]="$E_GIT"
  COMPONENT_ENABLED["changes"]="$E_CHANGES"
  COMPONENT_ENABLED["context"]="$E_CONTEXT"
  COMPONENT_ENABLED["limits"]="$E_LIMITS"
  COMPONENT_ENABLED["model"]="$E_MODEL"

  # Set component positions
  COMPONENT_POSITION["prjct_icon"]="$P_PRJCT_ICON"
  COMPONENT_POSITION["task"]="$P_TASK"
  COMPONENT_POSITION["linear"]="$P_LINEAR"
  COMPONENT_POSITION["jira"]="$P_JIRA"
  COMPONENT_POSITION["dir"]="$P_DIR"
  COMPONENT_POSITION["git"]="$P_GIT"
  COMPONENT_POSITION["changes"]="$P_CHANGES"
  COMPONENT_POSITION["context"]="$P_CONTEXT"
  COMPONENT_POSITION["limits"]="$P_LIMITS"
  COMPONENT_POSITION["model"]="$P_MODEL"

  # Update linear/jira enabled based on component config
  CONFIG_LINEAR_ENABLED="${COMPONENT_ENABLED["linear"]}"
  CONFIG_JIRA_ENABLED="${COMPONENT_ENABLED["jira"]}"

  # Update enrichment enabled from config
  [[ -n "$E_ENRICHMENT" ]] && CONFIG_ENRICHMENT_ENABLED="$E_ENRICHMENT"
}

# Check if a component is enabled
# Usage: if component_enabled "task"; then ...
component_enabled() {
  local name="$1"
  [[ "${COMPONENT_ENABLED[$name]}" == "true" ]]
}

# Get component position
# Usage: pos=$(component_position "task")
component_position() {
  local name="$1"
  echo "${COMPONENT_POSITION[$name]:-99}"
}

# Get sorted list of enabled components
# Usage: components=$(get_enabled_components)
get_enabled_components() {
  local components=()

  for name in "${!COMPONENT_ENABLED[@]}"; do
    if [[ "${COMPONENT_ENABLED[$name]}" == "true" ]]; then
      components+=("${COMPONENT_POSITION[$name]}:$name")
    fi
  done

  # Sort by position and extract names
  printf '%s\n' "${components[@]}" | sort -t: -k1 -n | cut -d: -f2
}
