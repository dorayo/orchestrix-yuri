# Phase 2: Plan Project

**Command**: `*plan`
**Purpose**: Drive all planning agents (Analyst → PM → UX-Expert → Architect → PO) via tmux to generate complete project documentation.

---

## Prerequisites

- Phase 1 (Create) must be complete
- `.yuri/memory.yaml` must exist with `phase1_create: complete`

---

## Step 0: Load Memory and Validate

1. Read `.yuri/memory.yaml` — restore project context
2. Verify `lifecycle.phase_status.phase1_create == complete`
   - If not → "Phase 1 not complete. Run `*create` first."
3. Set `PROJECT_DIR` from `project.project_root`
4. If `phase2_plan == in_progress` → find last completed planning step, resume from next
5. If `phase2_plan == complete` → offer skip to Phase 3

Update memory:
- `lifecycle.current_phase` → 2
- `lifecycle.phase_status.phase2_plan` → "in_progress"
- Save immediately

---

## Step 1: Create Planning tmux Session

Use the lazy session creation script:

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" planning "$PROJECT_DIR")
```

This creates an `op-{project-name}` tmux session with an initial window running Claude Code.

Update memory:
- `tmux.planning_session` → `$SESSION`
- Save immediately

---

## Step 2: Execute Planning Agents

Execute each agent step sequentially. Each step runs in a NEW tmux window.

### Agent Sequence

| Window | Agent | Command | Expected Output |
|--------|-------|---------|-----------------|
| 0 | analyst | `*create-doc project-brief` | `docs/project-brief.md` |
| 1 | pm | `*create-doc prd` | `docs/prd.md` |
| 2 | ux-expert | `*create-doc front-end-spec` | `docs/front-end-spec.md` |
| 3 | architect | `*create-doc fullstack-architecture` | `docs/architecture.md` |
| 4 | po | `*execute-checklist po-master-validation` | Validation report |
| 5 | po | `*shard` | `docs/prd/` + `docs/architecture/` |

### FOR EACH step (window_idx = 0..5):

**2.1** Report to user:
```
Starting {agent} ({n}/6)...
```

**2.2** Create new tmux window + start Claude Code:
```bash
if [ "$WINDOW_IDX" -gt 0 ]; then
  tmux new-window -t "$SESSION:$WINDOW_IDX" -n "{agent}" -c "$PROJECT_DIR"
fi
tmux send-keys -t "$SESSION:$WINDOW_IDX" "cc" C-m
sleep 2  # Wait for Claude Code to start
```

**2.3** Activate agent and send command:
```bash
tmux send-keys -t "$SESSION:$WINDOW_IDX" "/o {agent}" Enter
sleep 15  # Wait for agent to load
tmux send-keys -t "$SESSION:$WINDOW_IDX" "{command}" Enter
```

**2.4** Monitor completion:
```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
RESULT=$(bash "$SCRIPT_DIR/monitor-agent.sh" "$SESSION" "$WINDOW_IDX" "{expected_file}" 30 30)
```

Detection priority:
1. `/[A-Z][a-z]*ed for [0-9]/` — Claude Code completion (e.g. "Baked for 31s")
2. `○` idle indicator
3. `◐` approval prompt → auto-send `y` Enter
4. Content hash stable 3 polls (90s)

**2.5** Verify output file exists (if applicable):
```bash
test -f "$PROJECT_DIR/{expected_file}"
```

**2.6** Report to user and confirm:
```
✅ {agent} complete. Output: {file}
Continue / Review / Modify?
```

- **Continue** → next step
- **Review** → show file content summary
- **Modify** → user specifies changes, resend to agent in same window

**2.7** Save memory:
```
planning.steps[n].status = complete
planning.steps[n].output = "{expected_file}"
planning.steps[n].completed_at = "{ISO 8601 timestamp}"
```

### Special: Steps 4-5 (PO validate + shard)

Steps 4 and 5 share the same window (window 4):
1. Run `*execute-checklist po-master-validation` first, monitor completion
2. Then send `*shard` in the same window, monitor completion

---

## Step 3: All Complete

1. Kill planning session:
```bash
tmux kill-session -t "$SESSION"
```

2. Save checkpoint:
- `lifecycle.phase_status.phase2_plan` → "complete"
- `lifecycle.current_step` → "phase2.complete"
- Write checkpoint → `.yuri/checkpoints/checkpoint-phase2.yaml`

3. Output summary:
```
## ✅ Planning Phase Complete

All planning documents generated:
- `docs/project-brief.md` — Project brief
- `docs/prd/*.md` — Product requirements (sharded)
- `docs/front-end-spec*.md` — Frontend spec (if applicable)
- `docs/architecture*.md` — Architecture doc (sharded)
- Sharded context files for development
```

4. Ask:
```
🚀 Ready to start automated development? (Y/N)
```

- If Y → execute `tasks/yuri-develop-project.md`
- If N → save state, end with reminder: "Run `/yuri *develop` when ready."
