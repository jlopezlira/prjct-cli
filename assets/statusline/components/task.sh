#!/bin/bash
# prjct statusline - Task component
# Displays the current prjct task

component_task() {
  # DEAD DATA SOURCE: state moved to SQLite (v1.24+); storage/state.json no
  # longer exists, so this component can only ever render blank. Return before
  # paying stat/jq forks. Re-enable only with a live source (daemon snapshot).
  return

  component_enabled "task" || return

  local cache_file="${CACHE_DIR}/prjct_task.cache"
  local task=""

  # Check cache first
  if cache_valid "$cache_file" "$CONFIG_CACHE_TTL_PRJCT"; then
    task=$(cat "$cache_file")
  else
    # Get project ID
    local project_id=$(get_project_id)
    [[ -z "$project_id" ]] && return

    # Get state file
    local state_file="${HOME}/.prjct-cli/projects/${project_id}/storage/state.json"
    [[ ! -f "$state_file" ]] && return

    # Extract task title or description
    task=$(jq -r '.currentTask.title // .currentTask.description // ""' "$state_file" 2>/dev/null)

    # Truncate if too long
    local max_len="${CONFIG_TASK_MAX_LENGTH:-25}"
    if [[ ${#task} -gt $max_len ]]; then
      task="${task:0:$((max_len - 3))}..."
    fi

    # Cache the result
    write_cache "$cache_file" "$task"
  fi

  # Return empty if no task
  [[ -z "$task" ]] && return

  echo -e "${PURPLE}${task}${NC}"
}
