# Phase 3: Develop Project

**Command**: `*develop`
**Purpose**: Launch the automated development loop (SM → Architect → Dev → QA) via tmux and monitor progress until all stories are complete.

---

## Prerequisites

- Phase 2 (Plan) must be complete.
- Sharded docs must exist (`docs/prd/epic-*.yaml`).
- `{project}/.yuri/state/phase2.yaml` must have `status: complete`.

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

After Wake Up, validate:
1. Read `{project}/.yuri/state/phase2.yaml` → verify `status` = `complete`.
   - IF not → "Phase 2 not complete. Run `*plan` first." and stop.
2. Set `PROJECT_DIR` from `{project}/.yuri/identity.yaml` → `project.root`.
3. Count total epics/stories from `docs/prd/epic-*.yaml`:
```bash
TOTAL_STORIES=$(grep -r 'stories:' "$PROJECT_DIR/docs/prd/epic-"*.yaml 2>/dev/null | wc -l)
```

**Resumption check:**
- IF `{project}/.yuri/state/phase3.yaml` exists with `status: in_progress`:
  → Resume monitoring loop (Step 2).
- IF `{project}/.yuri/state/phase3.yaml` exists with `status: complete`:
  → Offer to skip to Phase 4.
- OTHERWISE → initialize `state/phase3.yaml` from `$TEMPLATES_DIR/phase3.template.yaml`.

Update memory:
- `{project}/.yuri/focus.yaml` → `phase: 3`, `step: "dev-launching"`, `action: "starting development automation"`, `updated_at: now`
- `{project}/.yuri/state/phase3.yaml` → `status: "in_progress"`, `started_at: now`, `progress.total_stories: {counted}`
- `~/.yuri/focus.yaml` → `active_action: "developing project: {name}"`, `updated_at: now`
- Append to `{project}/.yuri/timeline/events.jsonl`:
  ```jsonl
  {"ts":"{ISO-8601}","type":"phase_started","phase":3,"total_stories":{count}}
  ```
- Save all files immediately.

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
- `{project}/.yuri/focus.yaml` → `tmux.dev_session: "$SESSION"`, `step: "dev-monitoring"`, `action: "monitoring development loop"`
- `{project}/.yuri/state/phase3.yaml` → `tmux.session: "$SESSION"`
- Save immediately.

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

### 2.0 Re-read Memory (CRITICAL — prevents context drift)

At the **beginning of every poll cycle**, re-read L1 and L2 to ensure fresh state:

1. Read `~/.yuri/focus.yaml` — check if boss changed priority or another project needs attention.
2. Read `~/.yuri/portfolio/registry.yaml` — check for cross-project changes.
3. Read `{project}/.yuri/focus.yaml` — refresh current project state.
4. Read `{project}/.yuri/state/phase3.yaml` — refresh development progress.

IF `~/.yuri/focus.yaml` shows this project is no longer the highest priority
AND another project has `urgency: high` in `attention_queue`:
→ Report to user: "Note: {other-project} has high urgency. Continue monitoring {current}?"

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
2. Analyze for error patterns (exceptions, stuck loops, missing handoffs).
3. Attempt recovery:
   - Resend handoff to target window
   - `/clear` → restart agent
4. Increment `state/phase3.yaml` → `monitoring.stuck_count`.

IF `stuck_count` = 2 AND gstack is available:
- **Escalate to `/investigate`** before requesting human intervention.
- This provides a structured root cause analysis instead of blind retries.

```bash
test -d "$HOME/.claude/skills/gstack" && echo "gstack_available" || echo "gstack_missing"
```

IF gstack available:

Report to user:
```
🔍 Story stuck after 2 recovery attempts. Running root cause investigation...
```

Execute in Yuri's own session:

```
/investigate
```

Provide `/investigate` with context:
- Captured tmux pane contents from all 4 windows
- Current story ID and description
- Error patterns detected
- What recovery was already attempted

Wait for `/investigate` to complete. Parse output:
- **Root cause** identified?
- **Fix confidence** (1-10)
- **Recommended fix** with file:line references

IF fix confidence ≥ 8:
- Report to user: "Root cause identified: {summary}. Auto-fix recommended. Proceed? (Y/N)"
- IF Y → route fix to Dev agent via `*quick-fix "{investigate_fix_description}"`, then resume monitoring.
- IF N → present full investigation report, let user decide.

IF fix confidence < 8:
- Report full investigation to user with diagnostics:
  ```
  🔍 Investigation Report:
  - Symptom: {symptom}
  - Root cause: {root_cause or "inconclusive"}
  - Confidence: {score}/10
  - Recommended action: {action}

  Please advise: Fix manually / Retry / Skip this story / Pause?
  ```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"investigate","story":"{id}","root_cause":"{summary}","confidence":{score}}
```

IF `stuck_count > 3` (after investigate attempt or if gstack not available):
- Report to user with full diagnostics.
- Request human intervention.
- Pause monitoring loop.

### 2.4 Save Memory + Observe + Mini-Reflect

After each poll cycle:

**Save state** — update `{project}/.yuri/state/phase3.yaml`:
- `progress.by_status.done` → current done list
- `progress.by_status.in_progress` → current in-progress list
- `monitoring.poll_count` → increment
- `monitoring.last_progress_at` → timestamp of last progress change

**Observe** — check if any signals occurred during this cycle:
- User sent a message → check for preference/priority/correction signals.
- An error was resolved → tech_lesson signal.
- IF signal detected → append to `~/.yuri/inbox.jsonl`.

**Mini-Reflect** — update focus files:
- `{project}/.yuri/focus.yaml` → `pulse: "{done}/{total} stories done"`, `updated_at: now`
- `~/.yuri/focus.yaml` → `active_action: "monitoring dev: {done}/{total}"`, `updated_at: now`
- `~/.yuri/portfolio/registry.yaml` → this project's `pulse`

**Append timeline event** (only when progress changes):
```jsonl
{"ts":"{ISO-8601}","type":"story_completed","id":"{story_id}","epic":"{epic_id}"}
```

Save all files, then sleep 5 minutes before next poll cycle.

---

## Step 3: All Stories Done

1. Update memory:
- `{project}/.yuri/state/phase3.yaml` → `status: "complete"`, `completed_at: now`
- `{project}/.yuri/focus.yaml` → `step: "phase3.complete"`, `pulse: "Phase 3 complete, all {total} stories done"`

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

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

Phase 3 completes in Step 3, so the Close Out will trigger:
- F.1 Reflect (process inbox — development phase often generates many observations)
- F.2 Phase Reflect (review timeline → extract tech decisions, development insights, stuck patterns)
- F.3 Consolidate (promote universal lessons: e.g., "payment integrations take 3x", "Alpine lacks glibc")
- F.4 Decay (check stale wisdom entries)
