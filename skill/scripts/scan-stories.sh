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

# Count epics by unique filename prefix (e.g., 1.x → epic 1, 2.x → epic 2)
epics=$(ls "$STORIES_DIR" 2>/dev/null | grep -oE '^[0-9]+' | sort -u | wc -l | tr -d ' ')
echo "Epics:$epics"
