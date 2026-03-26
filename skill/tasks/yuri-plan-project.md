# Phase 2: Plan Project

**Command**: `*plan`
**Purpose**: Drive all planning agents (Analyst → PM → UX-Expert → Architect → PO) via tmux to generate complete project documentation.

---

## Prerequisites

- Phase 1 (Create) must be complete.
- `{project}/.yuri/state/phase1.yaml` must have `status: complete`.

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

After Wake Up, validate:
1. Read `{project}/.yuri/state/phase1.yaml` → verify `status` = `complete`.
   - IF not → "Phase 1 not complete. Run `*create` first." and stop.
2. Set `PROJECT_DIR` from `{project}/.yuri/identity.yaml` → `project.root`.

**Resumption check:**
- IF `{project}/.yuri/state/phase2.yaml` exists with `status: in_progress`:
  → Find the last step with `status: complete` → resume from the next step.
- IF `{project}/.yuri/state/phase2.yaml` exists with `status: complete`:
  → Offer to skip to Phase 3.
- OTHERWISE → initialize `state/phase2.yaml` from `$TEMPLATES_DIR/phase2.template.yaml`.

Update memory:
- `{project}/.yuri/focus.yaml` → `phase: 2`, `step: "planning"`, `action: "starting planning agents"`, `updated_at: now`
- `{project}/.yuri/state/phase2.yaml` → `status: "in_progress"`, `started_at: now`
- `~/.yuri/focus.yaml` → `active_action: "planning project: {name}"`, `updated_at: now`
- Append to `{project}/.yuri/timeline/events.jsonl`:
  ```jsonl
  {"ts":"{ISO-8601}","type":"phase_started","phase":2}
  ```
- Save all files immediately.

---

## Step 1: Create Planning tmux Session

Use the lazy session creation script:

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" planning "$PROJECT_DIR")
```

This creates an `op-{project-name}` tmux session with an initial window running Claude Code.

Update memory:
- `{project}/.yuri/focus.yaml` → `tmux.planning_session: "$SESSION"`
- `{project}/.yuri/state/phase2.yaml` → `tmux.session: "$SESSION"`
- Save immediately.

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
sleep 10  # Wait for agent to load
tmux send-keys -t "$SESSION:$WINDOW_IDX" "{command}" Enter
```

**2.3.1** When answering agent questions (multi-line text):
```bash
# Multi-line content is treated as a "paste" by Claude Code TUI.
# It lands in the input buffer but does NOT auto-submit.
# You MUST send Enter immediately after the content.
tmux send-keys -t "$SESSION:$WINDOW_IDX" "$(cat <<'EOF'
your multi-line answer here
EOF
)" Enter
# ^ Enter is CRITICAL — without it, content stays in input box
```

**IMPORTANT:** Do NOT use `/clear` within the planning phase. Each agent has its own
window and retains context for the entire phase. Only use `/clear` for error recovery
(see SKILL.md `/clear` Usage Rules).

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

Update `{project}/.yuri/state/phase2.yaml`:
```yaml
steps[n].status: complete
steps[n].output: "{expected_file}"
steps[n].completed_at: "{ISO 8601 timestamp}"
```

Append to `{project}/.yuri/timeline/events.jsonl`:
```jsonl
{"ts":"{ISO-8601}","type":"agent_completed","agent":"{agent}","output":"{expected_file}"}
```

Update `{project}/.yuri/focus.yaml`:
- `step` → "planning.{agent}.complete"
- `pulse` → "Phase 2: {n}/6 agents complete"
- `updated_at` → now

Update `~/.yuri/portfolio/registry.yaml` → this project's `pulse`.

**2.8** Observe: Check if the user expressed any preferences or corrections during 2.6.
IF signal detected → append to `~/.yuri/inbox.jsonl`.

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

2. Update memory:
- `{project}/.yuri/state/phase2.yaml` → `status: complete`, `completed_at: now`
- `{project}/.yuri/focus.yaml` → `step: "phase2.complete"`, `pulse: "Phase 2 complete, ready for development"`, `tmux.planning_session: ""`

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

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

Phase 2 completes in Step 3, so the Close Out will trigger:
- F.1 Reflect (process inbox observations from user interactions during planning)
- F.2 Phase Reflect (review Phase 2 timeline → extract architecture decisions, domain knowledge)
- F.3 Consolidate (check if any insights are universal)
- F.4 Decay (check stale entries)
