# Phase 4: Test Project

**Command**: `*test`
**Purpose**: Run smoke tests on each epic via the QA agent, fix failures through the Dev agent, and verify all epics pass.

---

## Prerequisites

- Phase 3 (Develop) must be complete
- Dev tmux session must be running (or will be recreated)
- `.yuri/memory.yaml` must exist with `phase3_develop: complete`

---

## Step 0: Load Memory and Collect Epic List

1. Read `.yuri/memory.yaml` — restore project context
2. Verify `lifecycle.phase_status.phase3_develop == complete`
   - If not → "Phase 3 not complete. Run `*develop` first."
3. Set `PROJECT_DIR` from `project.project_root`
4. Collect epic list from sharded PRD files:
```bash
ls "$PROJECT_DIR/docs/prd/epic-"*.yaml 2>/dev/null | sed 's/.*epic-//' | sed 's/\.yaml//'
```
5. If `phase4_test == in_progress` → resume from last untested epic
6. If `phase4_test == complete` → offer skip to Phase 5

Update memory:
- `lifecycle.current_phase` → 4
- `lifecycle.phase_status.phase4_test` → "in_progress"
- Save immediately

Ensure dev session is alive:
```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" dev "$PROJECT_DIR")
```

---

## Step 1: Reload QA Agent

Reload the QA agent in a clean state:

```bash
tmux send-keys -t "$SESSION:3" "/clear" Enter
sleep 2
tmux send-keys -t "$SESSION:3" "/o qa" Enter
sleep 12
```

Report to user:
```
🧪 QA agent reloaded. Starting smoke tests...
```

---

## Step 2: Smoke Test Each Epic

FOR EACH `epic_id` in the epic list:

### 2.1 Send Smoke Test Command

```bash
tmux send-keys -t "$SESSION:3" "*smoke-test $EPIC_ID" Enter
```

### 2.2 Monitor QA Completion

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
RESULT=$(bash "$SCRIPT_DIR/monitor-agent.sh" "$SESSION" 3 "" 30 30)
```

Use the same detection strategy (completion message → idle → stability).

### 2.3 Parse Results

Check for smoke test evidence in `docs/qa/evidence/`.

### 2.4 IF FAIL

Extract bug descriptions from QA output.

FOR EACH bug:

1. Reload Dev agent:
```bash
tmux send-keys -t "$SESSION:2" "/clear" Enter
sleep 2
tmux send-keys -t "$SESSION:2" "/o dev" Enter
sleep 12
```

2. Send quick-fix:
```bash
tmux send-keys -t "$SESSION:2" "*quick-fix \"$BUG_DESCRIPTION\"" Enter
```

3. Monitor Dev completion:
```bash
RESULT=$(bash "$SCRIPT_DIR/monitor-agent.sh" "$SESSION" 2 "" 30 30)
```

After all bugs fixed, run regression test:

1. Reload QA:
```bash
tmux send-keys -t "$SESSION:3" "/clear" Enter
sleep 2
tmux send-keys -t "$SESSION:3" "/o qa" Enter
sleep 12
```

2. Re-run smoke test:
```bash
tmux send-keys -t "$SESSION:3" "*smoke-test $EPIC_ID" Enter
```

3. Monitor and check results again
4. Increment `regression_rounds`

IF `regression_rounds > 3`:
- Escalate to user with full diagnostics
- Include QA evidence and Dev fix attempts
- Wait for user guidance

### 2.5 IF PASS

Mark epic as passed in memory:
```yaml
testing.epics[n].status: passed
testing.epics[n].rounds: {round_count}
```

Report:
```
✅ Epic {epic_id} passed smoke test ({rounds} round(s))
```

Proceed to next epic.

---

## Step 3: All Epics Pass

1. Save checkpoint:
- `lifecycle.phase_status.phase4_test` → "complete"
- `lifecycle.current_step` → "phase4.complete"
- Write checkpoint → `.yuri/checkpoints/checkpoint-phase4.yaml`

2. Report:
```
## ✅ Testing Phase Complete

All epics passed smoke testing:

| Epic | Status | Rounds |
|------|--------|--------|
| {id} | ✅ Pass | {n} |
| ... | ... | ... |
```

3. Present deployment options:
```
🚀 Ready to deploy! Run `/yuri *deploy` to see deployment options.
```

- If user confirms → execute `tasks/yuri-deploy-project.md`
- If user declines → save state, end with reminder
