#!/bin/bash
# Yuri Story Status Scanner
# Usage: scan-stories.sh <project_root>
#
# Outputs:
#   Total:{N}           total planned stories (from epic YAML definitions)
#   Created:{N}         stories with files in docs/stories/
#   StatusDone:{id}     per-file status (one line per story file)
#   StatusInProgress:{id}
#   StatusApproved:{id}
#   StatusReview:{id}
#   StatusBlocked:{id}
#   StatusOther:{id}
#   Epics:{N}           total epics (max N from docs/prd/epic-N-*)
#   CurrentEpic:{N}     current epic (max prefix from created stories)
#   CurrentStory:{id}   current story being worked on
set +e

PROJECT_ROOT="$1"
STORIES_DIR="$PROJECT_ROOT/docs/stories"
PRD_DIR="$PROJECT_ROOT/docs/prd"

# ── Total planned stories from epic YAML definitions ──
# Count "- id:" entries under "stories:" in each epic YAML
total_planned=0
if [ -d "$PRD_DIR" ]; then
  for yaml in "$PRD_DIR"/epic-*.yaml; do
    [ -f "$yaml" ] || continue
    # Count lines matching "  - id:" (story entries in the stories array)
    n=$(grep -cE '^\s+- id:' "$yaml" 2>/dev/null || echo 0)
    total_planned=$((total_planned + n))
  done
fi
echo "Total:$total_planned"

# ── Created stories (files in docs/stories/) ──
if [ ! -d "$STORIES_DIR" ]; then
  echo "Created:0"
  echo "Epics:0"
  echo "CurrentEpic:0"
  echo "CurrentStory:none"
  exit 0
fi

created=$(ls "$STORIES_DIR"/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "Created:$created"

# ── Per-file status extraction ──
in_progress_story=""
for f in "$STORIES_DIR"/*.md; do
  [ -f "$f" ] || continue
  fname=$(basename "$f" .md)

  # Try heading format: "## Status" then next non-empty line
  status=$(awk '/^## Status/{found=1; next} found && /^[[:space:]]*$/{next} found{print; exit}' "$f" 2>/dev/null)

  # Fallback: inline "Status: XXX"
  if [ -z "$status" ]; then
    status=$(grep -m1 -oE 'Status:\s*\S+' "$f" 2>/dev/null | sed 's/Status:\s*//')
  fi

  # Normalize to lowercase, strip whitespace
  status_lower=$(echo "$status" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

  case "$status_lower" in
    done) echo "StatusDone:$fname" ;;
    inprogress|in_progress|in-progress) echo "StatusInProgress:$fname"; in_progress_story="$fname" ;;
    review|inreview|in_review) echo "StatusReview:$fname" ;;
    blocked) echo "StatusBlocked:$fname" ;;
    approved) echo "StatusApproved:$fname" ;;
    *) echo "StatusOther:$fname" ;;
  esac
done

# ── Epics: max N from docs/prd/epic-N-* ──
if [ -d "$PRD_DIR" ]; then
  epics=$(ls "$PRD_DIR" 2>/dev/null | grep -oE '^epic-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
  echo "Epics:${epics:-0}"
else
  echo "Epics:0"
fi

# ── CurrentEpic: max prefix from story filenames ──
current_epic=$(ls "$STORIES_DIR" 2>/dev/null | grep -oE '^[0-9]+' | sort -n | tail -1)
echo "CurrentEpic:${current_epic:-0}"

# ── CurrentStory: InProgress or highest numbered ──
if [ -n "$in_progress_story" ]; then
  echo "CurrentStory:$in_progress_story"
else
  latest=$(ls "$STORIES_DIR"/*.md 2>/dev/null | sort -V | tail -1)
  if [ -n "$latest" ]; then
    echo "CurrentStory:$(basename "$latest" .md)"
  else
    echo "CurrentStory:none"
  fi
fi
