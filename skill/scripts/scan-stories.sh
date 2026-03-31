#!/bin/bash
# Yuri Story Status Scanner
# Usage: scan-stories.sh <project_root>
#
# Supports two status formats in story files:
#   Format A: "Status: Done" (inline)
#   Format B: "## Status\n\nDone" (heading + next non-empty line)
#
# Also outputs epic count based on filename prefix (e.g., 1.x, 2.x)
set +e

STORIES_DIR="$1/docs/stories"

if [ ! -d "$STORIES_DIR" ]; then
  echo "NO_STORIES_DIR"
  exit 1
fi

# Scan each story file for status
for status in Done InProgress Review Blocked Approved AwaitingArchReview RequiresRevision Escalated; do
  count=0
  for f in "$STORIES_DIR"/*.md "$STORIES_DIR"/*.yaml; do
    [ -f "$f" ] || continue
    # Format A: "Status: Done" or "Status:Done"
    if grep -qi "Status:[[:space:]]*$status" "$f" 2>/dev/null; then
      count=$((count + 1))
      continue
    fi
    # Format B: "## Status" heading, then status on a subsequent non-empty line
    if grep -q "## Status" "$f" 2>/dev/null; then
      # Extract the first non-empty line after "## Status"
      extracted=$(awk '/^## Status/{found=1; next} found && /^[[:space:]]*$/{next} found{print; exit}' "$f" 2>/dev/null)
      if echo "$extracted" | grep -qi "^$status$" 2>/dev/null; then
        count=$((count + 1))
      fi
    fi
  done
  echo "$status:$count"
done

# Count total epics from docs/prd/epic-N-*.yaml (max N = total epics)
PRD_DIR="$1/docs/prd"
if [ -d "$PRD_DIR" ]; then
  epics=$(ls "$PRD_DIR" 2>/dev/null | grep -oE '^epic-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
  echo "Epics:${epics:-0}"
else
  echo "Epics:0"
fi

# Current epic (max prefix from story files)
current_epic=$(ls "$STORIES_DIR" 2>/dev/null | grep -oE '^[0-9]+' | sort -n | tail -1)
echo "CurrentEpic:${current_epic:-0}"
