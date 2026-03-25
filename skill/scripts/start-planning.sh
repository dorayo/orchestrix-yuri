#!/bin/bash
# Yuri Planning Session Creator
# Usage: start-planning.sh <project_dir>
set -e

PROJECT_DIR="${1:-.}"
PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)
PROJECT_NAME=$(basename "$PROJECT_DIR")
SESSION="op-$(echo "$PROJECT_NAME" | tr -cd 'a-zA-Z0-9_-')"

# Kill existing session if present
tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"

# Create session with initial window
tmux new-session -d -s "$SESSION" -n "Plan" -c "$PROJECT_DIR"

# Start Claude Code
tmux send-keys -t "$SESSION:0" "cc" C-m

echo "$SESSION"
