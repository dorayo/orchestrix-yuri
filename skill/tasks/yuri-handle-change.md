# Change Management

**Command**: `*change "{description}"`
**Purpose**: Handle mid-project requirement changes by assessing scope and routing to the appropriate workflow.

---

## Step 0: Load Memory and Context

1. Read `.yuri/memory.yaml` — restore project context
2. Set `PROJECT_DIR` from `project.project_root`
3. Determine current phase from `lifecycle.current_phase`
4. Extract the change description from the user's command argument

Update memory:
- `lifecycle.current_step` → "change_management"
- Save immediately

---

## Step 1: Scope Assessment

Assess the change size based on the current phase and change description.

### Scope Assessment Matrix

| Current Phase | Change Size | Action | Needs Planning Session? |
|---------------|-------------|--------|------------------------|
| Phase 2 | Any | Modify current/subsequent planning step inputs | Already exists |
| Phase 3 | Small (≤5 files) | Dev `*solo "{description}"` | No |
| Phase 3 | Medium | PO `*route-change` → standard workflow | **Yes** |
| Phase 3 | Large (cross-module/DB/security) | Pause dev → partial Phase 2 re-plan | **Yes** |
| Phase 4 | Any | Queue for next iteration | No (record only) |
| Phase 5+ | New iteration | PM `*start-iteration` → plan → dev → test | **Yes** |

Present assessment to user:

```
## 📋 Change Assessment

| Item | Detail |
|------|--------|
| **Current Phase** | Phase {n} ({phase_name}) |
| **Change** | {description} |
| **Assessed Size** | {Small / Medium / Large} |
| **Recommended Action** | {action} |

Proceed with this approach? (Y/N, or specify alternative)
```

Wait for user confirmation.

---

## Step 2: Execute Based on Scope

### Small Change (Phase 3, ≤5 files)

No planning session needed. Use Dev directly:

```bash
SESSION="{tmux.dev_session}"
# Ensure dev session is alive
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" dev "$PROJECT_DIR")

# Send to Dev
tmux send-keys -t "$SESSION:2" "/clear" Enter
sleep 2
tmux send-keys -t "$SESSION:2" "/o dev" Enter
sleep 12
tmux send-keys -t "$SESSION:2" "*solo \"$CHANGE_DESCRIPTION\"" Enter
```

Monitor Dev completion, then resume normal Phase 3 monitoring.

### Medium Change (Phase 3)

Requires planning session for PO routing:

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"

# 1. Ensure planning session
PLAN_SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" planning "$PROJECT_DIR")

# 2. Activate PO and route change
tmux send-keys -t "$PLAN_SESSION:0" "/o po" Enter
sleep 15
tmux send-keys -t "$PLAN_SESSION:0" "*route-change \"$CHANGE_DESCRIPTION\"" Enter
```

Wait for PO routing result. Then:

- IF routes to **Architect**:
```bash
tmux send-keys -t "$PLAN_SESSION:0" "/clear" Enter
sleep 2
tmux send-keys -t "$PLAN_SESSION:0" "/o architect" Enter
sleep 15
tmux send-keys -t "$PLAN_SESSION:0" "*resolve-change" Enter
```

- IF routes to **PM**:
```bash
tmux send-keys -t "$PLAN_SESSION:0" "/clear" Enter
sleep 2
tmux send-keys -t "$PLAN_SESSION:0" "/o pm" Enter
sleep 15
tmux send-keys -t "$PLAN_SESSION:0" "*revise-prd" Enter
```

Wait for Proposal output (PCP/TCP).

Then switch to dev session:
```bash
DEV_SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" dev "$PROJECT_DIR")

# In SM window: apply proposal
tmux send-keys -t "$DEV_SESSION:1" "/clear" Enter
sleep 2
tmux send-keys -t "$DEV_SESSION:1" "/o sm" Enter
sleep 12
tmux send-keys -t "$DEV_SESSION:1" "*apply-proposal {proposal_id}" Enter
```

SM → Architect → Dev → QA auto-loop resumes.

### Large Change (Phase 3, cross-module/DB/security)

Same as medium change flow but with explicit pause notification:

```
⚠️ Large change detected. Pausing development loop for re-planning...
```

Follow the medium change flow, then resume Phase 3 monitoring.

### Phase 4 Change (Queue for next iteration)

Record only — do not execute during testing:

```
📝 Change recorded for next iteration: {description}
Current testing will continue. This change will be addressed in the next development cycle.
```

### Post-MVP Iteration (Phase 5+)

Full iteration flow using PM `*start-iteration`:

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"

# Step 1: PM generates next-steps.md
PLAN_SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" planning "$PROJECT_DIR")
tmux send-keys -t "$PLAN_SESSION:0" "/o pm" Enter
sleep 15
tmux send-keys -t "$PLAN_SESSION:0" "*start-iteration" Enter
```

Monitor PM completion. PM creates: `docs/prd/epic-*.yaml` + `docs/prd/*next-steps.md`

**Step 2: Parse next-steps.md**

Read the generated next-steps file. Split on `🎯 HANDOFF TO {agent}:` markers.
Build ordered execution queue:
```
[{agent: "ux-expert", content: "..."},
 {agent: "architect", content: "..."},
 {agent: "sm", content: "..."}]
```

**Step 3: Execute each HANDOFF section (STOP before SM)**

FOR EACH section WHERE agent != "sm":
1. Create new window in planning tmux session
2. Start `cc`, wait for startup
3. Activate agent: `/o {agent}`
4. Paste the section content as instructions to the agent
5. Monitor completion (detect "Xed for Ns" / ○ idle)
6. Report to user, offer review
7. Save progress to memory

**Step 4: SM handoff → transition to dev automation**

When reaching `🎯 HANDOFF TO sm:`:
1. Kill planning session (done)
2. Ensure dev session:
```bash
DEV_SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" dev "$PROJECT_DIR")
```
3. In SM window (window 1) of dev session:
```bash
tmux send-keys -t "$DEV_SESSION:1" "/clear" Enter
sleep 2
tmux send-keys -t "$DEV_SESSION:1" "/o sm" Enter
sleep 12
tmux send-keys -t "$DEV_SESSION:1" "*draft" Enter
```
SM creates first story → handoff chain auto-starts (SM → Arch → Dev → QA)

**Step 5: Resume Phase 3 monitoring**

Enter standard development monitoring loop (see `tasks/yuri-develop-project.md` Step 2).
When all new stories complete → Phase 4 testing → Phase 5 incremental deployment if needed.

---

## Step 3: Record Change

Save change record to memory regardless of scope:

```yaml
changes.history:
  - timestamp: "{ISO 8601}"
    phase: {current_phase}
    description: "{change_description}"
    scope: "{small/medium/large}"
    action_taken: "{what was done}"
```

Save memory immediately.

---

## Step 4: Resume Normal Flow

After change is handled:
- If in Phase 3 → resume development monitoring loop
- If in Phase 4 → continue testing
- If post-MVP iteration → follow through Phase 3 → 4 → 5 cycle

Report to user:
```
✅ Change handled: {description}
Action taken: {action_summary}
Resuming {current_phase_name}...
```
