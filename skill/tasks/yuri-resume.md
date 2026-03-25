# Resume from Checkpoint

**Command**: `*resume`
**Purpose**: Detect interrupted state and resume project execution from the last saved checkpoint.

---

## Step 1: Read Memory

```bash
MEMORY_FILE=".yuri/memory.yaml"
```

- If `.yuri/memory.yaml` not found → "No project state found. Use `*create` to start a new project."
- If found → read and parse full memory state

---

## Step 2: Display Status Summary

Present current project state:

```
## 📊 Project Status

| Item | Detail |
|------|--------|
| **Project** | {project.name} |
| **Path** | {project.project_root} |
| **Current Phase** | Phase {lifecycle.current_phase} |
| **Current Step** | {lifecycle.current_step} |
| **Last Active** | {timestamp from memory file mtime} |

### Phase Progress
| Phase | Status |
|-------|--------|
| 1. Create | {phase1_create} |
| 2. Plan | {phase2_plan} |
| 3. Develop | {phase3_develop} |
| 4. Test | {phase4_test} |
| 5. Deploy | {phase5_deploy} |
```

If in Phase 3 (Develop), also show:
```
### Development Progress
- Stories: {stories_done}/{total_stories}
- In Progress: {stories_in_progress}
- Stuck Count: {stuck_count}
```

---

## Step 3: Check Recoverability

Perform diagnostic checks:

1. **tmux sessions alive?**
```bash
# Check planning session
tmux has-session -t "{tmux.planning_session}" 2>/dev/null && echo "ALIVE" || echo "DEAD"

# Check dev session
tmux has-session -t "{tmux.dev_session}" 2>/dev/null && echo "ALIVE" || echo "DEAD"
```

2. **Expected files exist?**
   - Check for output files of completed planning steps
   - Check for story files if in development phase

3. **Incomplete operations?**
   - Any planning step marked `in_progress`?
   - Any stories stuck in `InProgress` or `Review`?

Report findings:
```
### Recovery Diagnostics
- Planning session: {ALIVE/DEAD}
- Dev session: {ALIVE/DEAD}
- Expected files: {all present / missing: list}
- Incomplete operations: {none / list}
```

---

## Step 4: Offer Resume Options

Based on the interrupted state, present options:

```
Detected interruption at Phase {n}, Step {m}.

Options:
  1. **Resume from checkpoint** — Continue from last saved state
  2. **Re-execute current step** — Retry the step that was interrupted
  3. **Skip to next phase** — Mark current phase complete and advance

Select (1/2/3):
```

Wait for user selection.

---

## Step 5: Execute Recovery

Based on user's choice:

### Option 1: Resume from checkpoint

1. Load the latest checkpoint from `.yuri/checkpoints/`
2. Recreate any needed tmux sessions using `ensure-session.sh`
3. Call the appropriate phase task file with resume context:
   - Phase 2 → `tasks/yuri-plan-project.md` (will detect `in_progress` and resume)
   - Phase 3 → `tasks/yuri-develop-project.md` (will re-enter monitoring loop)
   - Phase 4 → `tasks/yuri-test-project.md` (will resume from last untested epic)
   - Phase 5 → `tasks/yuri-deploy-project.md` (will resume deployment)

### Option 2: Re-execute current step

1. Reset the current step status to `pending` in memory
2. Recreate any needed tmux sessions
3. Call the appropriate phase task file (step will re-run from beginning)

### Option 3: Skip to next phase

1. Mark current phase as `complete` in memory
2. Write checkpoint
3. Advance `lifecycle.current_phase` by 1
4. Call the next phase task file

After any option, save updated memory immediately.
