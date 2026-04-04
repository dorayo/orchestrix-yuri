# Phase 1: Create Project

**Command**: `*create`
**Purpose**: Collect project information from user and scaffold a complete Orchestrix project.

---

## Prerequisites

- `~/.yuri/self.yaml` must exist (run `npx orchestrix-yuri install` if missing).

## Resource Directory

```bash
RESOURCE_DIR="${CLAUDE_SKILL_DIR}/resources"
TEMPLATES_DIR="${CLAUDE_SKILL_DIR}/templates"
```

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

For Phase 1 (create), no project L2 exists yet. Step 0.3 is skipped — only load L1 (global context).

**Resumption check after Wake Up:**
- IF the current working directory contains `.yuri/identity.yaml` AND `.yuri/state/phase1.yaml` with `status: complete`:
  → Offer to skip to Phase 2.
- IF `.yuri/state/phase1.yaml` exists with `status: in_progress`:
  → Resume from the last completed step.
- Otherwise → proceed to Step 1.

---

## Step 1: Collect Orchestrix License Key

**Auto-discovery (try before asking)**:
Search for an existing license key in this order:
1. `~/.yuri/portfolio/registry.yaml` — check all projects for `license_key` field
2. `~/Codes/*/.yuri/identity.yaml` — scan sibling projects for `project.license_key`
3. `~/Codes/*/.mcp.json` — look for `Bearer orch_live_*` or `Bearer orch_trial_*`
4. Environment variable `ORCHESTRIX_LICENSE_KEY`

If a valid key is found (starts with `orch_live_` or `orch_trial_`):
→ Use it automatically. Inform user: "Found existing license key: orch_live_...{last 4 chars}. Using it."
→ Skip to Step 2.

**If no key found, ask the user.**

**Validation rules**:
- Must start with `orch_live_` or `orch_trial_`
- No key → inform: "Apply at https://orchestrix-mcp.youlidao.ai"
- User says "configure later" → record empty, use `YOUR_LICENSE_KEY_HERE` placeholder
- Invalid format → prompt again with format hint

---

## Step 2: Collect Project Basics

Ask the user for:
1. **Project name** (Chinese or English)
2. **Core problem** (1-3 sentences describing what the project solves)

Auto-generate the directory name:
- Chinese → translate to English meaning, kebab-case (e.g. "智能柜管理系统" → `smart-locker-management`)
- English → kebab-case
- Max 30 characters

---

## Step 3: Confirm Summary

Present this confirmation to the user:

```
## 📋 Project Understanding Confirmation

| Item | Content |
|------|---------|
| **Project Name** | {name} |
| **Project Directory** | ~/Codes/{kebab-name}/ |
| **Core Problem** | {description} |
| **License Key** | {provided / pending} |

Confirm? (Y/N, or specify what to change)
```

Wait for `Y`. If `N` → return to the specific question the user wants to change.

---

## Step 4: Create Directory Structure

After user confirms, create the project skeleton:

```bash
PROJECT_DIR=~/Codes/{dir-name}
mkdir -p "$PROJECT_DIR/docs"
mkdir -p "$PROJECT_DIR/.claude/commands"
mkdir -p "$PROJECT_DIR/.claude/hooks"
mkdir -p "$PROJECT_DIR/.orchestrix-core/scripts"
mkdir -p "$PROJECT_DIR/.yuri/knowledge"
mkdir -p "$PROJECT_DIR/.yuri/state"
mkdir -p "$PROJECT_DIR/.yuri/timeline"
mkdir -p "$PROJECT_DIR/.yuri/checkpoints"
```

---

## Step 5: Generate .mcp.json

```bash
RESOURCE_DIR="${CLAUDE_SKILL_DIR}/resources"
```

1. Read `$RESOURCE_DIR/mcp.json.template`
2. Replace `{{ORCHESTRIX_LICENSE_KEY}}` → user's key (or `YOUR_LICENSE_KEY_HERE`)
3. Write → `$PROJECT_DIR/.mcp.json`

If a non-template `mcp.json` exists in resources, use it directly.

---

## Step 6: Copy Orchestrix Infrastructure

```bash
RESOURCE_DIR="${CLAUDE_SKILL_DIR}/resources"

cp "$RESOURCE_DIR/settings.local.json"     "$PROJECT_DIR/.claude/settings.local.json"
cp "$RESOURCE_DIR/handoff-detector.sh"     "$PROJECT_DIR/.claude/hooks/handoff-detector.sh"
chmod +x "$PROJECT_DIR/.claude/hooks/handoff-detector.sh"
cp "$RESOURCE_DIR/o.md"                    "$PROJECT_DIR/.claude/commands/o.md"
cp "$RESOURCE_DIR/o-help.md"               "$PROJECT_DIR/.claude/commands/o-help.md"
cp "$RESOURCE_DIR/o-status.md"             "$PROJECT_DIR/.claude/commands/o-status.md"
cp "$RESOURCE_DIR/start-orchestrix.sh"     "$PROJECT_DIR/.orchestrix-core/scripts/start-orchestrix.sh"
chmod +x "$PROJECT_DIR/.orchestrix-core/scripts/start-orchestrix.sh"
```

**Note on trust dialog:** Claude Code shows a "trust this directory?" dialog when entering a new project.
This is handled automatically by `ensure-session.sh` and `start-orchestrix.sh`, which detect the trust
prompt in the tmux pane and send Enter to accept it during the startup wait period.

---

## Step 7: Generate core-config.yaml

1. Read `$RESOURCE_DIR/core-config.template.yaml`
2. Replace placeholders:
   - `{{PROJECT_NAME}}` → project name
   - `{{REPO_ID}}` → english directory name (kebab-case)
   - `{{TEST_COMMAND}}` → infer from tech stack:

| Tech Stack | Test Command |
|------------|-------------|
| Node.js / React / Next.js / Vue | `npm test` |
| Python / Django / Flask / FastAPI | `pytest` |
| Go | `go test ./...` |
| Java / Spring | `./gradlew test` |
| Deno | `deno test -A` |
| Other / Unknown | (empty, auto-detect later) |

3. Write → `$PROJECT_DIR/.orchestrix-core/core-config.yaml`

---

## Step 8: Generate .gitignore

Write to `$PROJECT_DIR/.gitignore`:

```
node_modules/
vendor/
venv/
__pycache__/
.env
.env.local
.env.*.local
.DS_Store
Thumbs.db
dist/
build/
out/
*.log
.idea/
.vscode/
*.swp
*.swo
.orchestrix-core/runtime/
```

If a `.gitignore.template` exists in resources, use that instead.

---

## Step 9: Initialize Memory (Four-Layer Structure)

### 9.1 Project Identity

Read `$TEMPLATES_DIR/identity.template.yaml`. Populate fields:
- `project.name` → project name
- `project.root` → absolute path to `$PROJECT_DIR`
- `project.description` → core problem statement
- `project.created_at` → current ISO 8601 timestamp
- `project.license_key` → collected key or empty

Write → `$PROJECT_DIR/.yuri/identity.yaml`

### 9.2 Project Focus

Read `$TEMPLATES_DIR/project-focus.template.yaml`. Set:
- `phase` → 1
- `step` → "creating"
- `action` → "initializing project skeleton"
- `pulse` → "Phase 1: project creation in progress"
- `updated_at` → current ISO 8601 timestamp

Write → `$PROJECT_DIR/.yuri/focus.yaml`

### 9.3 Phase 1 State

Read `$TEMPLATES_DIR/phase1.template.yaml`. Set:
- `status` → "in_progress"
- `created_at` → current ISO 8601 timestamp
- `collected.name` → project name
- `collected.dir_name` → kebab-case directory name
- `collected.license_key` → collected key or empty
- `collected.description` → core problem statement

Write → `$PROJECT_DIR/.yuri/state/phase1.yaml`

### 9.4 Timeline

Create empty `$PROJECT_DIR/.yuri/timeline/events.jsonl`.
Append first event:
```jsonl
{"ts":"{ISO-8601}","type":"phase_started","phase":1,"detail":"Project created: {project_name}"}
```

### 9.5 Knowledge Directory

Create placeholder files:
```bash
echo "# Architecture Decisions" > "$PROJECT_DIR/.yuri/knowledge/decisions.md"
echo "# Domain Knowledge" > "$PROJECT_DIR/.yuri/knowledge/domain.md"
echo "# Project Insights" > "$PROJECT_DIR/.yuri/knowledge/insights.md"
```

### 9.6 Register in Portfolio

Read `~/.yuri/portfolio/registry.yaml`.
Append to the `projects` array:
```yaml
- id: "{dir-name}"
  name: "{project-name}"
  root: "{absolute-path}"
  phase: 1
  status: active
  pulse: "Phase 1: creating project"
  started_at: "{ISO-8601}"
```
Write back `~/.yuri/portfolio/registry.yaml`.

### 9.7 Update Global Focus

Read `~/.yuri/focus.yaml`. Set:
- `active_project` → `{dir-name}`
- `active_action` → "creating project: {project-name}"
- `updated_at` → current ISO 8601 timestamp

Add to `attention_queue` if not already present:
```yaml
- project: "{dir-name}"
  urgency: medium
  next: "Phase 1 create completing"
```

Write back `~/.yuri/focus.yaml`.

---

## Step 10: Git Init + Commit

```bash
cd "$PROJECT_DIR" && git init && git add .
git commit -m "chore: init project with Orchestrix

- Project brief generated from interactive session
- Orchestrix infrastructure: MCP config, hooks, slash commands
- Core config with project-specific settings
- Four-layer Yuri memory system initialized

🤖 Generated with [Orchestrix](https://orchestrix-mcp.youlidao.ai)"
```

---

## Step 11: Output Result and Complete Phase

Display to the user:

```
## ✅ Project Created
**Path**: ~/Codes/{dir-name}/

### Files created
- `.mcp.json` — Orchestrix MCP Server config
- `.claude/settings.local.json` — Claude Code hooks config
- `.claude/hooks/handoff-detector.sh` — HANDOFF auto-detection hook
- `.claude/commands/o.md` — /o command (Agent activation)
- `.claude/commands/o-help.md` — /o-help command
- `.claude/commands/o-status.md` — /o-status command
- `.orchestrix-core/core-config.yaml` — Project config
- `.orchestrix-core/scripts/start-orchestrix.sh` — tmux multi-window automation
- `.yuri/` — Four-layer memory system
- `.gitignore` — Git ignore rules
```

IF license key is empty, add warning:

```
⚠️ License Key not configured. Edit .mcp.json, replace YOUR_LICENSE_KEY_HERE.
Apply at: https://orchestrix-mcp.youlidao.ai
```

Update memory:
1. Set `$PROJECT_DIR/.yuri/state/phase1.yaml` → `status: complete`, `completed_at: {ISO-8601}`
2. Set `$PROJECT_DIR/.yuri/focus.yaml` → `step: "phase1.complete"`, `pulse: "Phase 1 complete, ready for planning"`
3. Update `~/.yuri/portfolio/registry.yaml` → this project's `pulse` → "Phase 1 complete"
4. Append to `$PROJECT_DIR/.yuri/timeline/events.jsonl`:
   ```jsonl
   {"ts":"{ISO-8601}","type":"phase_completed","phase":1}
   ```

---

## Step 12: Ask Whether to Start Planning

```
🚀 **Start project planning now?**

| Step | Agent | Task | Output |
|------|-------|------|--------|
| 0 | Analyst | Create project brief | docs/project-brief.md |
| 1 | PM | Generate PRD | docs/prd/*.md |
| 2 | UX Expert | Frontend spec | docs/front-end-spec*.md |
| 3 | Architect | Architecture doc | docs/architecture*.md |
| 4 | PO | Validate + shard | Reports + sharded files |

Reply: **Y** (start now) or **N** (plan manually later)
```

- If Y → execute `tasks/yuri-plan-project.md`
- If N → save state, end with reminder: "Run `/yuri *plan` when ready."

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

Phase 1 completes in Step 11, so the Close Out will trigger:
- F.1 Reflect (process any inbox observations)
- F.2 Phase Reflect (extract knowledge from Phase 1 timeline — minimal at this stage)
- F.3 Consolidate (check for universal insights — minimal at this stage)
- F.4 Decay (no-op for first project)
