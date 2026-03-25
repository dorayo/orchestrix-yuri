#!/bin/bash
# Yuri Story Status Scanner
# Usage: scan-stories.sh <project_root>
set +e

STORIES_DIR="$1/docs/stories"

if [ ! -d "$STORIES_DIR" ]; then
  echo "NO_STORIES_DIR"
  exit 1
fi

for status in Done InProgress Review Blocked Approved AwaitingArchReview RequiresRevision Escalated; do
  count=$(grep -rl "Status:.*$status" "$STORIES_DIR" 2>/dev/null | wc -l | tr -d ' ')
  echo "$status:$count"
done
