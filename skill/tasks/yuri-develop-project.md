# Phase 3: Develop Project

**Command**: `*develop`
**Purpose**: Launch the automated development loop (SM → Architect → Dev → QA) via tmux and monitor progress until all stories are complete.

---

## Prerequisites

- Phase 2 (Plan) must be complete
- Sharded docs must exist (`docs/prd/epic-*.yaml`)
- `.yuri/memory.yaml` must exist with `phase2_plan: complete`

---

## Step 0: Load Memory and Validate

1. Read `.yuri/memory.yaml` — restore project context
2. Verify `lifecycle.phase_status.phase2_plan == complete`
   - If not → "Phase 2 not complete. Run `*plan` first."
3. Set `PROJECT_DIR` from `project.project_root`
4. Count total epics/stories from `docs/prd/epic-*.yaml`:
```bash
TOTAL_STORIES=$(grep -r 'stories:' "$PROJECT_DIR/docs/prd/epic-"*.yaml 2>/dev/null | wc -l)
```
5. If `phase3_develop == in_progress` → resume monitoring loop
6. If `phase3_develop == complete` → offer skip to Phase 4

Update memory:
- `lifecycle.current_phase` → 3
- `lifecycle.phase_status.phase3_develop` → "in_progress"
- `development.total_stories` → counted total
- Save immediately

---

## Step 1: Launch Dev Automation

Use the lazy session creation script:

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" dev "$PROJECT_DIR")
```

This creates an `orchestrix-{repo-id}` tmux session with 4 windows:
- Window 0: Architect
- Window 1: SM (Scrum Master)
- Window 2: Dev
- Window 3: QA

SM auto-starts the development loop upon session creation.

Update memory:
- `tmux.dev_session` → `$SESSION`
- Save immediately

Report to user:
```
🚀 Development session started: {SESSION}
4 agents active: Architect, SM, Dev, QA
SM is beginning the development loop...
```

---

## Step 2: Monitoring Loop

Poll every 5 minutes until all stories are done.

```
WHILE stories_done < total_stories:
```

### 2.1 Scan Story Statuses

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
RESULT=$(bash "$SCRIPT_DIR/scan-stories.sh" "$PROJECT_DIR")
```

Output: count by status (Blocked, InProgress, Review, Done, etc.)

### 2.2 Report to User

```
📊 Progress: {done}/{total} stories
✅ Done: {list of done story IDs}
🔄 In Progress: {list}
⏳ Remaining: {count}
```

### 2.3 Stuck Detection

IF no progress for 15 minutes (3 consecutive polls with same done count):
1. Capture all 4 tmux window contents:
```bash
for W in 0 1 2 3; do
  tmux capture-pane -t "$SESSION:$W" -p -S -50
done
```
2. Analyze for error patterns (exceptions, stuck loops, missing handoffs)
3. Attempt recovery:
   - Resend handoff to target window
   - `/clear` → restart agent
4. Increment `development.stuck_count`

IF `stuck_count > 3`:
- Report to user with full diagnostics
- Request human intervention
- Pause monitoring loop

### 2.4 Save Memory

After each poll cycle:
- `development.stories_done` → current done count
- `development.stories_in_progress` → list of in-progress story IDs
- `development.last_progress_at` → timestamp of last progress change
- Save immediately

---

## Step 3: All Stories Done

1. Save checkpoint:
- `lifecycle.phase_status.phase3_develop` → "complete"
- `lifecycle.current_step` → "phase3.complete"
- Write checkpoint → `.yuri/checkpoints/checkpoint-phase3.yaml`

2. Report:
```
## ✅ Development Phase Complete

All {total} stories implemented!

| Status | Count |
|--------|-------|
| Done | {done} |
| Total | {total} |

Development session: {SESSION} (still running for QA phase)
```

3. Ask:
```
🚀 Ready to start smoke testing? (Y/N)
```

- If Y → execute `tasks/yuri-test-project.md`
- If N → save state, end with reminder: "Run `/yuri *test` when ready."
