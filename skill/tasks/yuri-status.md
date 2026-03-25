# Project Status Query

**Command**: `*status`
**Purpose**: Display comprehensive project status without modifying any state.

---

## Step 1: Read Memory

```bash
MEMORY_FILE=".yuri/memory.yaml"
```

- If `.yuri/memory.yaml` not found → "No project state found. Use `*create` to start a new project."
- If found → read and parse full memory state

---

## Step 2: Display Project Overview

```
## 📊 Project Status: {project.name}

| Item | Detail |
|------|--------|
| **Project** | {project.name} |
| **Path** | {project.project_root} |
| **Description** | {project.description} |
| **Tech Stack** | {project.tech_stack} |
| **Created** | {project.created_at} |
| **License** | {configured / pending} |
```

---

## Step 3: Display Phase Progress

```
### Lifecycle Progress

| Phase | Status | Detail |
|-------|--------|--------|
| 1. Create | {✅/🔄/⏳} {status} | Project scaffold |
| 2. Plan | {✅/🔄/⏳} {status} | Planning docs |
| 3. Develop | {✅/🔄/⏳} {status} | Story implementation |
| 4. Test | {✅/🔄/⏳} {status} | Smoke testing |
| 5. Deploy | {✅/🔄/⏳} {status} | Deployment |

**Current**: Phase {current_phase} — {current_step}
```

Status icons:
- `✅` = complete
- `🔄` = in_progress
- `⏳` = pending
- `❌` = failed

---

## Step 4: Display Phase-Specific Details

### If Phase 2 (Plan) is in progress or complete:

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

### If Phase 3 (Develop) is in progress or complete:

Scan current story statuses:
```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
bash "$SCRIPT_DIR/scan-stories.sh" "$PROJECT_DIR"
```

```
### Development Progress

| Metric | Value |
|--------|-------|
| Total Stories | {total} |
| Done | {done} |
| In Progress | {in_progress} |
| In Review | {review} |
| Blocked | {blocked} |
| Remaining | {remaining} |

Progress: [{done}/{total}] {'█' * pct}{'░' * (100-pct)} {pct}%
```

### If Phase 4 (Test) is in progress or complete:

```
### Testing Progress

| Epic | Status | Rounds |
|------|--------|--------|
| {id} | {✅ Pass / ❌ Fail / ⏳ Pending} | {n} |
| ... | ... | ... |
```

### If Phase 5 (Deploy) is complete:

```
### Deployment

| Item | Detail |
|------|--------|
| Strategy | {strategy} |
| URL | {url} |
| Status | {status} |
```

---

## Step 5: Display tmux Session Status

Check if tmux sessions are alive:

```bash
# Planning session
tmux has-session -t "{tmux.planning_session}" 2>/dev/null && echo "ALIVE" || echo "DEAD"

# Dev session
tmux has-session -t "{tmux.dev_session}" 2>/dev/null && echo "ALIVE" || echo "DEAD"
```

```
### Active Sessions

| Session | Name | Status |
|---------|------|--------|
| Planning | {planning_session} | {ALIVE/DEAD/N/A} |
| Development | {dev_session} | {ALIVE/DEAD/N/A} |
```

If any change history exists:
```
### Change History

| # | Timestamp | Phase | Description | Action |
|---|-----------|-------|-------------|--------|
| 1 | {ts} | {phase} | {desc} | {action} |
| ... | ... | ... | ... | ... |
```

**Note**: This command is read-only. No state is modified.
