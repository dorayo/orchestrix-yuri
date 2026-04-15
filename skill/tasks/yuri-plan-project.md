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
# CRITICAL: Every tmux send-keys MUST follow the pattern:
#   send-keys "content" → sleep 1 → send-keys Enter
# Claude Code TUI needs time to process pasted text before Enter.
# Sending content and Enter in one call can cause the Enter to be lost.

tmux send-keys -t "$SESSION:$WINDOW_IDX" "/o {agent}"
sleep 1
tmux send-keys -t "$SESSION:$WINDOW_IDX" Enter
sleep 10  # Wait for agent to load

tmux send-keys -t "$SESSION:$WINDOW_IDX" "{command}"
sleep 1
tmux send-keys -t "$SESSION:$WINDOW_IDX" Enter
```

**2.3.1** When answering agent questions or sending any text to agent windows:
```bash
# ALWAYS use this 3-step pattern for sending content to Claude Code:
#   Step 1: send-keys "content"    (pastes text into input box)
#   Step 2: sleep 1                (let TUI process the paste)
#   Step 3: send-keys Enter        (submit the input)
#
# NEVER combine content and Enter in a single send-keys call.
# NEVER skip the sleep — without it, Enter may arrive before TUI is ready.

tmux send-keys -t "$SESSION:$WINDOW_IDX" "$(cat <<'EOF'
your multi-line answer here
EOF
)"
sleep 1
tmux send-keys -t "$SESSION:$WINDOW_IDX" Enter
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
- `{project}/.yuri/focus.yaml` → `step: "phase2.complete"`, `pulse: "Phase 2 complete, ready for review"`, `tmux.planning_session: ""`

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

4. Proceed to Plan Review Gate (Step 4).

---

## Step 4: Plan Review Gate (gstack)

**Purpose**: Use gstack review skills to challenge assumptions, audit architecture, and validate design before writing any code. Catching issues here is 10x cheaper than catching them in development.

### 4.0 Check gstack availability

```bash
test -d "$HOME/.claude/skills/gstack" && echo "gstack_available" || echo "gstack_missing"
```

IF `gstack_missing` → skip to Step 4.5 (ask user to proceed to development).

### 4.1 Ask user for review depth

```
## 📋 Plan Review Gate

Planning is complete. Before development begins, I can run independent quality reviews on the plan using gstack:

| # | Review | What it does | Time |
|---|--------|-------------|------|
| 1 | **Full Review** | CEO strategy + Eng architecture + Design (if UI) | ~10 min |
| 2 | **Eng Only** | Architecture, test coverage, failure modes | ~5 min |
| 3 | **Skip** | Go straight to development | 0 min |

Recommendation: **Full Review** for new projects, **Eng Only** for iterations.
Select (1/2/3):
```

- IF user selects **3 (Skip)** → go to Step 4.5.
- IF user selects **2 (Eng Only)** → run only Step 4.3.
- IF user selects **1 (Full Review)** → run Steps 4.2 through 4.4.

### 4.2 CEO Strategy Review (`/plan-ceo-review`)

Report:
```
🎯 Plan Review 1/3: CEO Strategy Review — challenging scope and premises...
```

Execute in Yuri's own session:

```
/plan-ceo-review
```

This runs in **HOLD SCOPE** mode by default (maximum rigor without scope creep).

Wait for completion. Key outputs to capture:
- Premise challenges
- Error/rescue registry
- Failure modes
- "Not in scope" section
- Review readiness score

IF `/plan-ceo-review` proposes plan modifications:
- Show diff summary to user.
- Ask: "Accept changes / Modify / Reject?"
- IF accepted → plan files updated (gstack writes directly).
- IF rejected → revert changes, continue with original plan.

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"plan_review","reviewer":"ceo","status":"complete"}
```

### 4.3 Engineering Architecture Review (`/plan-eng-review`)

Report:
```
🏗️ Plan Review 2/3: Engineering Review — locking architecture and test strategy...
```

Execute:

```
/plan-eng-review
```

Key outputs:
- Architecture diagram
- Coverage diagram (code paths with test status)
- Failure mode analysis per new codepath
- Worktree parallelization strategy
- Issues found per section

IF review proposes plan changes → same accept/modify/reject flow as 4.2.

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"plan_review","reviewer":"eng","status":"complete"}
```

### 4.4 Design Review (`/plan-design-review`) — UI projects only

Check if project has UI components:
1. Look for frontend files or frontend stack in `{project}/.yuri/identity.yaml`.
2. Check if `docs/front-end-spec*.md` exists.

IF no UI → skip with note:
```
ℹ️ Plan Review 3/3: Design Review — skipped (no UI components)
```

IF UI present:

Report:
```
🎨 Plan Review 3/3: Design Review — auditing UX dimensions...
```

Execute:

```
/plan-design-review
```

Key outputs:
- 7-dimension scorecard (info architecture, interaction states, user journey, AI slop risk, design system, responsive/a11y, unresolved decisions)
- Updated plan with design decisions filled in

IF review proposes changes → same accept/modify/reject flow.

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"plan_review","reviewer":"design","status":"complete"}
```

### 4.5 Review Summary + Transition

```
## 📋 Plan Review Complete

| Review | Status | Key Finding |
|--------|--------|-------------|
| CEO Strategy | {✅/⏭️} | {one-line summary} |
| Eng Architecture | {✅/⏭️} | {one-line summary} |
| Design | {✅/⏭️} | {one-line summary} |

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
