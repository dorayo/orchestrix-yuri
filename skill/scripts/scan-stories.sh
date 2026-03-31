#!/bin/bash
# Yuri Story Status Scanner
# Usage: scan-stories.sh <project_root>
#
# Outputs:
#   {Status}:{count} for each status (Done, InProgress, etc.)
#   Total:{N}         total story files
#   Epics:{N}         total epics (max N from docs/prd/epic-N-*)
#   CurrentEpic:{N}   current epic (max prefix from story filenames)
#   CurrentStory:{id} current story being worked on
set +e

PROJECT_ROOT="$1"
STORIES_DIR="$PROJECT_ROOT/docs/stories"

if [ ! -d "$STORIES_DIR" ]; then
  echo "NO_STORIES_DIR"
  exit 1
fi

# Count total story files
total=$(ls "$STORIES_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Total:$total"

# Extract status from each story file
# Supports: "## Status\n\nDone" (heading format) and "Status: Done" (inline)
in_progress_story=""
for f in "$STORIES_DIR"/*.md; do
  [ -f "$f" ] || continue
  fname=$(basename "$f" .md)

  # Try heading format first: "## Status" then next non-empty line
  status=$(awk '/^## Status/{found=1; next} found && /^[[:space:]]*$/{next} found{print; exit}' "$f" 2>/dev/null)

  # Fallback: inline "Status: XXX"
  if [ -z "$status" ]; then
    status=$(grep -oP 'Status:\s*\K\S+' "$f" 2>/dev/null | head -1)
  fi

  # Normalize
  status=$(echo "$status" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

  case "$status" in
    done) echo "StatusDone:$fname" ;;
    inprogress|in_progress|in-progress) echo "StatusInProgress:$fname"; in_progress_story="$fname" ;;
    review|inreview) echo "StatusReview:$fname" ;;
    blocked) echo "StatusBlocked:$fname" ;;
    approved) echo "StatusApproved:$fname" ;;
    *) echo "StatusOther:$fname" ;;
  esac
done

# Count epics from docs/prd/epic-N-* (max N = total epics)
PRD_DIR="$PROJECT_ROOT/docs/prd"
if [ -d "$PRD_DIR" ]; then
  epics=$(ls "$PRD_DIR" 2>/dev/null | grep -oE '^epic-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
  echo "Epics:${epics:-0}"
else
  echo "Epics:0"
fi

# Current epic (max prefix from story filenames)
current_epic=$(ls "$STORIES_DIR" 2>/dev/null | grep -oE '^[0-9]+' | sort -n | tail -1)
echo "CurrentEpic:${current_epic:-0}"

# Current story: InProgress one, or highest numbered
if [ -n "$in_progress_story" ]; then
  echo "CurrentStory:$in_progress_story"
else
  latest=$(ls "$STORIES_DIR"/*.md 2>/dev/null | sort -t/ -k2 -V | tail -1)
  if [ -n "$latest" ]; then
    echo "CurrentStory:$(basename "$latest" .md)"
  fi
fi
