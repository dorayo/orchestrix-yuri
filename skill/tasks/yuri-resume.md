# Resume from Checkpoint

**Command**: `*resume`
**Purpose**: Detect interrupted state and resume project execution from the last saved checkpoint.

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

---

## Step 1: Detect Project Context

### 1.1 Check for New Memory Structure

IF `{project}/.yuri/identity.yaml` exists → use new four-layer memory system. Proceed to Step 2.

### 1.2 Check for Legacy Memory (backward compatibility)

IF `{project}/.yuri/memory.yaml` exists BUT `{project}/.yuri/identity.yaml` does NOT:
- Inform user: "Detected legacy memory format. Migration required."
- Ask: "Run migration now? (Y/N)"
- IF Y → run `node ~/.claude/skills/yuri/../../../lib/migrate.js "{project_root}"` (or inline migration logic).
- IF N → "Run `npx orchestrix-yuri migrate` manually, then retry `*resume`." and stop.

### 1.3 No Memory Found

IF neither `.yuri/identity.yaml` nor `.yuri/memory.yaml` exists:
- "No project state found in this directory. Use `*create` to start a new project."
- Stop.

---

## Step 2: Display Status Summary

Read from the four-layer structure:
- `{project}/.yuri/identity.yaml` → project info
- `{project}/.yuri/focus.yaml` → current phase, step, pulse
- Check which `{project}/.yuri/state/phase{1-5}.yaml` files exist and their status.

Present:

```
## 📊 Project Status

| Item | Detail |
|------|--------|
| **Project** | {identity.project.name} |
| **Path** | {identity.project.root} |
| **Current Phase** | Phase {focus.phase} |
| **Current Step** | {focus.step} |
| **Last Active** | {focus.updated_at} |

### Phase Progress
| Phase | Status |
|-------|--------|
| 1. Create | {state/phase1.yaml status or "N/A"} |
| 2. Plan | {state/phase2.yaml status or "N/A"} |
| 3. Develop | {state/phase3.yaml status or "N/A"} |
| 4. Test | {state/phase4.yaml status or "N/A"} |
| 5. Deploy | {state/phase5.yaml status or "N/A"} |
```

IF in Phase 3 (Develop), also show:
```
### Development Progress
- Stories: {by_status.done count}/{total_stories}
- In Progress: {by_status.in_progress}
- Stuck Count: {monitoring.stuck_count}
```

---

## Step 3: Check Recoverability

Perform diagnostic checks:

1. **tmux sessions alive?**
```bash
# Check planning session (if recorded)
PLAN_SESSION=$(read from focus.yaml → tmux.planning_session)
test -n "$PLAN_SESSION" && tmux has-session -t "$PLAN_SESSION" 2>/dev/null && echo "ALIVE" || echo "DEAD"

# Check dev session (if recorded)
DEV_SESSION=$(read from focus.yaml → tmux.dev_session)
test -n "$DEV_SESSION" && tmux has-session -t "$DEV_SESSION" 2>/dev/null && echo "ALIVE" || echo "DEAD"
```

2. **Expected files exist?**
   - Check for output files of completed planning steps (if Phase 2+).
   - Check for story files if in development phase (if Phase 3+).

3. **Incomplete operations?**
   - Any planning step in `state/phase2.yaml` marked `in_progress`?
   - Any stories stuck in progress (from `state/phase3.yaml`)?

Report findings:
```
### Recovery Diagnostics
- Planning session: {ALIVE/DEAD/N/A}
- Dev session: {ALIVE/DEAD/N/A}
- Expected files: {all present / missing: list}
- Incomplete operations: {none / list}
```

---

## Step 4: Offer Resume Options

Based on the interrupted state, present options:

```
Detected interruption at Phase {n}, Step: {step}.

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

1. Load the latest checkpoint from `{project}/.yuri/checkpoints/`.
2. Recreate any needed tmux sessions using `ensure-session.sh`.
3. Call the appropriate phase task file:
   - Phase 2 → `tasks/yuri-plan-project.md` (will detect `in_progress` and resume)
   - Phase 3 → `tasks/yuri-develop-project.md` (will re-enter monitoring loop)
   - Phase 4 → `tasks/yuri-test-project.md` (will resume from last untested epic)
   - Phase 5 → `tasks/yuri-deploy-project.md` (will resume deployment)

### Option 2: Re-execute current step

1. Reset the current step status to `pending` in the appropriate `state/phaseN.yaml`.
2. Recreate any needed tmux sessions.
3. Call the appropriate phase task file (step will re-run from beginning).

### Option 3: Skip to next phase

1. Mark current phase as `complete` in `state/phaseN.yaml`.
2. Write checkpoint → `checkpoints/phaseN.yaml`.
3. Advance `{project}/.yuri/focus.yaml` → `phase` by 1.
4. Append phase_completed event to timeline.
5. Call the next phase task file.

After any option, save updated memory immediately.

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

Note: Resume itself does not complete a phase. F.2-F.4 (Phase Reflect, Consolidate, Decay) will only trigger if the resumed task subsequently completes a phase.
