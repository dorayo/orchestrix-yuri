# Project Status Query

**Command**: `*status`
**Purpose**: Display comprehensive project status without modifying any state. Supports multi-project portfolio view.

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

**Note**: For `*status`, Step 0 is read-only. Do NOT update focus.yaml or portfolio.yaml — this is a pure query command.

---

## Step 1: Portfolio Overview

Read `~/.yuri/portfolio/registry.yaml`.

IF multiple projects exist with `status: active` or `status: maintenance`:

```
## 📊 Portfolio Overview

| # | Project | Phase | Status | Pulse |
|---|---------|-------|--------|-------|
{for each project: | N | name | Phase X | status | pulse |}
```

IF only one project exists, skip the portfolio table and go directly to Step 2.

---

## Step 2: Current Project Detail

Determine the target project:
- IF CWD matches a project in `registry.yaml` → use that project.
- IF the user specified a project name → use that project.
- IF only one project exists → use that project.
- OTHERWISE → ask the user which project to show detail for.

Read project memory:
- `{project}/.yuri/identity.yaml`
- `{project}/.yuri/focus.yaml`

```
## 📊 Project Status: {identity.project.name}

| Item | Detail |
|------|--------|
| **Project** | {project.name} |
| **Path** | {project.root} |
| **Description** | {project.description} |
| **Tech Stack** | {project.stack} |
| **Created** | {project.created_at} |
| **License** | {configured / pending} |
| **Current Phase** | Phase {focus.phase} — {focus.step} |
| **Last Active** | {focus.updated_at} |
```

---

## Step 3: Phase Progress

Check which `{project}/.yuri/state/phase{1-5}.yaml` files exist and their status.

```
### Lifecycle Progress

| Phase | Status | Detail |
|-------|--------|--------|
| 1. Create | {✅/🔄/⏳} {status} | Project scaffold |
| 2. Plan | {✅/🔄/⏳} {status} | Planning docs |
| 3. Develop | {✅/🔄/⏳} {status} | Story implementation |
| 4. Test | {✅/🔄/⏳} {status} | Smoke testing |
| 5. Deploy | {✅/🔄/⏳} {status} | Deployment |
```

Status icons:
- `✅` = complete
- `🔄` = in_progress
- `⏳` = pending
- `❌` = failed

---

## Step 4: Phase-Specific Details

### IF Phase 2 (Plan) is in progress or complete:

Read `{project}/.yuri/state/phase2.yaml`.

```
### Planning Progress

| Step | Agent | Status | Output |
|------|-------|--------|--------|
| 0 | Analyst | {status} | {output file} |
| 1 | PM | {status} | {output file} |
| 2 | UX Expert | {status} | {output file} |
| 3 | Architect | {status} | {output file} |
| 4 | PO Validate | {status} | {output file} |
| 5 | PO Shard | {status} | {output file} |
```

### IF Phase 3 (Develop) is in progress or complete:

**Generate a progress card** using these data sources:

**1. Scan story statuses:**
```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
bash "$SCRIPT_DIR/scan-stories.sh" "$PROJECT_DIR"
```

The script outputs:
- `Total:{N}` — total planned stories from all `docs/prd/epic-*.yaml` definitions
- `Created:{N}` — story files in `docs/stories/`
- `StatusDone:{filename}` / `StatusInProgress:{filename}` / etc. — per-file status
- `Epics:{N}` — total epics (max N from `docs/prd/epic-N-*`)
- `CurrentEpic:{N}` — epic of current story
- `CurrentStory:{filename}` — InProgress or last non-Done story

**2. Detect active tmux agent:**
```bash
# Check which orchestrix-* session exists
tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^orchestrix-"

# For each window (0=Architect, 1=SM, 2=Dev, 3=QA):
# - Window showing "Command | Description" table = IDLE
# - Window WITHOUT that table = actively executing
for w in 0 1 2 3; do
  OUTPUT=$(tmux capture-pane -t "$DEV_SESSION:$w" -p -S -15)
  if ! echo "$OUTPUT" | grep -q "Command.*Description"; then
    echo "Window $w is ACTIVE"
  fi
done
```

**3. Format the progress card:**

```
📊 Dev Progress Report
━━━━━━━━━━━━━━━━━━━━━
Epic: {CurrentEpic}/{Epics}
Story: {done}/{total} done ({pct}%) | {created} created
▓▓▓▓▓▓░░░░░░░░░░░░░░ {pct}%
━━━━━━━━━━━━━━━━━━━━━
✅ Done: {N}
🔄 InProgress: {N}
📋 Approved: {N}
📝 Draft: {N}
━━━━━━━━━━━━━━━━━━━━━
📝 Current: {CurrentStory}
🤖 Agent: {active_agent} (window {N})
⏱ Running for {elapsed}
```

Where:
- `{pct}` = round(done / total * 100)
- Progress bar: `▓` for filled, `░` for empty (20 chars total)
- Only show status categories with count > 0
- `{elapsed}` = time since `focus.updated_at` or `phase3.started_at`
- If no agent is active (all windows show Command table), show "All agents idle (waiting for handoff)"

### IF Phase 4 (Test) is in progress or complete:

Read `{project}/.yuri/state/phase4.yaml`.

```
### Testing Progress

| Epic | Status | Rounds |
|------|--------|--------|
| {id} | {✅ Pass / ❌ Fail / ⏳ Pending} | {n} |
| ... | ... | ... |
```

### IF Phase 5 (Deploy) is complete:

Read `{project}/.yuri/state/phase5.yaml`.

```
### Deployment

| Item | Detail |
|------|--------|
| Strategy | {strategy} |
| URL | {url} |
| Health | {health} |
```

---

## Step 5: tmux Session Status

Check if tmux sessions are alive:

```bash
PLAN_SESSION=$(from focus.yaml → tmux.planning_session)
DEV_SESSION=$(from focus.yaml → tmux.dev_session)

test -n "$PLAN_SESSION" && tmux has-session -t "$PLAN_SESSION" 2>/dev/null && echo "ALIVE" || echo "DEAD"
test -n "$DEV_SESSION" && tmux has-session -t "$DEV_SESSION" 2>/dev/null && echo "ALIVE" || echo "DEAD"
```

```
### Active Sessions

| Session | Name | Status |
|---------|------|--------|
| Planning | {planning_session} | {ALIVE/DEAD/N/A} |
| Development | {dev_session} | {ALIVE/DEAD/N/A} |
```

---

## Step 6: Recent Activity (optional)

Read the last 10 entries from `{project}/.yuri/timeline/events.jsonl`.

```
### Recent Activity

| Time | Event |
|------|-------|
| {ts} | {type}: {detail} |
| ... | ... |
```

---

**Note**: This command is read-only. No state is modified. No Final Step (Close Out) is needed.
