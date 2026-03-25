# Phase 1: Create Project

**Command**: `*create`
**Purpose**: Collect project information from user and scaffold a complete Orchestrix project.

---

## Prerequisites

- None (this is the entry point)

## Resource Directory

```bash
RESOURCE_DIR="${CLAUDE_SKILL_DIR}/resources"
# Resolves to: ~/.claude/skills/yuri/resources/
```

---

## Step 0: Check Resumption

- If `.yuri/memory.yaml` exists AND `phase1_create: complete` → offer skip to Phase 2
- If `.yuri/memory.yaml` exists AND `phase1_create: in_progress` → resume from last saved step
- Otherwise → proceed to Step 1

---

## Step 1: Collect Orchestrix License Key

Ask the user for their Orchestrix license key.

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
mkdir -p "$PROJECT_DIR/.yuri/phase-logs"
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

## Step 9: Initialize Memory

Read the memory template from `${CLAUDE_SKILL_DIR}/templates/memory.template.yaml` and populate it with collected data:

- `project.name` → project name
- `project.dir_name` → kebab-case directory name
- `project.project_root` → absolute path to project directory
- `project.license_key` → collected key or empty
- `project.description` → core problem statement
- `project.created_at` → current ISO 8601 timestamp
- `lifecycle.current_phase` → 1
- `lifecycle.current_step` → "phase1.step9.memory_init"
- `lifecycle.phase_status.phase1_create` → "in_progress"

Write → `$PROJECT_DIR/.yuri/memory.yaml`

---

## Step 10: Git Init + Commit

```bash
cd "$PROJECT_DIR" && git init && git add .
git commit -m "chore: init project with Orchestrix

- Project brief generated from interactive session
- Orchestrix infrastructure: MCP config, hooks, slash commands
- Core config with project-specific settings

🤖 Generated with [Orchestrix](https://orchestrix-mcp.youlidao.ai)"
```

---

## Step 11: Output Result

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
- `.gitignore` — Git ignore rules
```

IF license key is empty, add warning:

```
⚠️ License Key not configured. Edit .mcp.json, replace YOUR_LICENSE_KEY_HERE.
Apply at: https://orchestrix-mcp.youlidao.ai
```

Update memory:
- `lifecycle.phase_status.phase1_create` → "complete"
- `lifecycle.current_phase` → 1
- `lifecycle.current_step` → "phase1.complete"

Save checkpoint → `.yuri/checkpoints/checkpoint-phase1.yaml`

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
