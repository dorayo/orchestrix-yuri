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
    # Count story-level entries only (2-space indent: "  - id:")
    # Deeper indentation (4+ spaces) are acceptance_criteria, business_rules, etc.
    n=$(grep -cE '^  - id:' "$yaml" 2>/dev/null || echo 0)
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

  # Fallback: inline "status: Done" or "Status: Done" (case-insensitive)
  if [ -z "$status" ]; then
    status=$(grep -m1 -oiE 'status:\s*\S+' "$f" 2>/dev/null | sed 's/[Ss]tatus:\s*//')
  fi

  # Normalize to lowercase, strip whitespace
  status_lower=$(echo "$status" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

  case "$status_lower" in
    done|complete|completed) echo "StatusDone:$fname" ;;
    inprogress|in_progress|in-progress|wip) echo "StatusInProgress:$fname"; in_progress_story="$fname" ;;
    review|inreview|in_review|underreview) echo "StatusReview:$fname" ;;
    blocked) echo "StatusBlocked:$fname" ;;
    approved|ready) echo "StatusApproved:$fname" ;;
    draft|new|todo|pending|open) echo "StatusDraft:$fname" ;;
    awaitingarchreview|awaiting_arch_review) echo "StatusAwaitingArchReview:$fname" ;;
    requiresrevision|requires_revision) echo "StatusRequiresRevision:$fname" ;;
    escalated) echo "StatusEscalated:$fname" ;;
    "") echo "StatusNoStatus:$fname" ;;
    *) echo "Status${status}:$fname" ;;
  esac
done

# ── Epics: max N from docs/prd/epic-N-* ──
if [ -d "$PRD_DIR" ]; then
  epics=$(ls "$PRD_DIR" 2>/dev/null | grep -oE '^epic-[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1)
  echo "Epics:${epics:-0}"
else
  echo "Epics:0"
fi

# ── CurrentEpic + CurrentStory: based on InProgress story ──
# Priority: InProgress story > last non-Done story > highest numbered
if [ -n "$in_progress_story" ]; then
  echo "CurrentStory:$in_progress_story"
  current_epic=$(echo "$in_progress_story" | grep -oE '^[0-9]+')
  echo "CurrentEpic:${current_epic:-0}"
else
  # Find last non-Done story (most likely being worked on next)
  last_non_done=""
  for f in $(ls "$STORIES_DIR"/*.md 2>/dev/null | sort -V); do
    [ -f "$f" ] || continue
    s=$(awk '/^## Status/{found=1; next} found && /^[[:space:]]*$/{next} found{print; exit}' "$f" 2>/dev/null)
    s_lower=$(echo "$s" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [ "$s_lower" != "done" ]; then
      last_non_done=$(basename "$f" .md)
    fi
  done
  if [ -n "$last_non_done" ]; then
    echo "CurrentStory:$last_non_done"
    current_epic=$(echo "$last_non_done" | grep -oE '^[0-9]+')
    echo "CurrentEpic:${current_epic:-0}"
  else
    echo "CurrentStory:none"
    echo "CurrentEpic:0"
  fi
fi
