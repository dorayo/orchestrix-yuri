# Orchestrix Yuri — Meta-Orchestrator

Yuri is a **Meta-Orchestrator** that takes natural language from users and autonomously drives all [Orchestrix](https://orchestrix-mcp.youlidao.ai) agents through the full project lifecycle.

```
User describes idea → Yuri drives: Create → Plan → Develop → Test → Deploy
```

## How It Works

Yuri is a [Claude Code skill](https://code.claude.com/docs/en/skills) that orchestrates specialized AI agents via tmux sessions:

| Phase | What Yuri Does | Agents Involved |
|-------|---------------|-----------------|
| **1. Create** | Collects project info, scaffolds directory, configures Orchestrix | — |
| **2. Plan** | Drives planning agents sequentially via tmux | Analyst → PM → UX-Expert → Architect → PO |
| **3. Develop** | Launches 4-agent dev automation, monitors progress | SM ↔ Architect ↔ Dev ↔ QA |
| **4. Test** | Runs smoke tests per epic, fixes bugs, regression tests | QA + Dev |
| **5. Deploy** | Recommends and executes deployment strategy | — |

## Installation

```bash
npx orchestrix-yuri install
```

This installs the Yuri skill globally to `~/.claude/skills/yuri/`.

### Prerequisites

- [Claude Code](https://claude.com/claude-code) CLI installed
- [tmux](https://github.com/tmux/tmux) installed (`brew install tmux`)
- An Orchestrix License Key (get one at [orchestrix-mcp.youlidao.ai](https://orchestrix-mcp.youlidao.ai))

## Usage

In any Claude Code session:

```
/yuri
```

Then either:
- Describe your project idea in natural language
- Use a specific command: `*create`, `*plan`, `*develop`, `*test`, `*deploy`

### Commands

| Command | Description |
|---------|-------------|
| `*create` | Create a new project (Phase 1) |
| `*plan` | Start/resume project planning (Phase 2) |
| `*develop` | Start/resume automated development (Phase 3) |
| `*test` | Start/resume smoke testing (Phase 4) |
| `*deploy` | Start/resume deployment (Phase 5) |
| `*status` | Show current project phase and progress |
| `*resume` | Resume from last saved checkpoint |
| `*change "{desc}"` | Handle mid-project requirement change |

## Architecture

```
~/.claude/skills/yuri/          ← Globally installed skill
├── SKILL.md                    ← Agent persona + activation protocol
├── tasks/                      ← Phase workflow instructions
├── scripts/                    ← Shell scripts (tmux control, monitoring)
├── templates/                  ← Memory schema
├── data/                       ← Decision rules (deployment, routing)
└── resources/                  ← Files copied to new projects
```

### Memory System

Yuri maintains per-project state in `.yuri/memory.yaml`, enabling:
- **Resumption**: Pick up from any interruption point
- **Progress tracking**: Real-time story/epic completion counts
- **Change management**: History of requirement changes and actions taken
- **Error recovery**: Automatic retry with escalation

### tmux Sessions

| Session | Purpose | Windows |
|---------|---------|---------|
| `op-{project}` | Planning phase | One per agent (Analyst, PM, UX, Architect, PO) |
| `orchestrix-{repo-id}` | Development phase | 4 fixed (Architect, SM, Dev, QA) |

Sessions are **lazily created and recreated** — if a session dies or is killed, Yuri automatically rebuilds it when needed.

### Completion Detection

Yuri monitors agent completion in tmux panes using a priority-based detection system:

1. **Claude Code completion message**: Pattern like "Baked for 31s" (`[A-Z][a-z]*ed for [0-9]`)
2. **TUI idle indicator**: `○` symbol
3. **Approval prompt**: `◐` → auto-approved
4. **Content stability**: Pane unchanged for 90 seconds

## Change Management

Yuri handles mid-project changes based on scope:

| Scope | Action |
|-------|--------|
| Small (≤5 files) | Dev `*solo` directly |
| Medium | PO `*route-change` → standard workflow |
| Large | Pause dev, partial re-plan |
| New iteration | PM `*start-iteration` → parse next-steps.md → drive agents → resume dev |

## Deployment Options

| Region | Provider | Best For |
|--------|----------|----------|
| China | Sealos | Prototype / MVP |
| China | Aliyun ECS + Docker | Production |
| China | Vercel (CN) | Frontend / SSR |
| Overseas | Vercel | Frontend / Full-stack |
| Overseas | Railway | Backend APIs |
| Overseas | AWS / GCP | Enterprise |

## License

MIT
