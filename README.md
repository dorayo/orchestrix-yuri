# Orchestrix Yuri — Meta-Orchestrator

Yuri is a **Meta-Orchestrator** that takes natural language from users and autonomously drives all [Orchestrix](https://orchestrix-mcp.youlidao.ai) agents through the full project lifecycle.

```
User describes idea → Yuri drives: Create → Plan → Develop → Test → Deploy
```

## How It Works

Yuri is a [Claude Code skill](https://code.claude.com/docs/en/skills) + Channel Gateway. Two ways to use:

1. **Terminal mode** — activate `/yuri` inside any Claude Code session
2. **Telegram mode** — chat with Yuri via Telegram bot

| Phase | What Yuri Does | Agents Involved |
|-------|---------------|-----------------|
| **1. Create** | Collects project info, scaffolds directory, configures Orchestrix | — |
| **2. Plan** | Drives planning agents sequentially via tmux | Analyst → PM → UX-Expert → Architect → PO |
| **3. Develop** | Launches 4-agent dev automation, monitors progress | SM ↔ Architect ↔ Dev ↔ QA |
| **4. Test** | Runs smoke tests per epic, fixes bugs, regression tests | QA + Dev |
| **5. Deploy** | Recommends and executes deployment strategy | — |

## Prerequisites

- **Node.js** >= 18
- **[Claude Code](https://claude.com/claude-code)** CLI installed and logged in
- **[tmux](https://github.com/tmux/tmux)** installed (`brew install tmux` on macOS, `apt install tmux` on Linux)
- **Orchestrix License Key** (get one at [orchestrix-mcp.youlidao.ai](https://orchestrix-mcp.youlidao.ai))
- **Telegram Bot Token** (for Telegram mode — get from [@BotFather](https://t.me/BotFather))

## Installation

### Method A: From npm (recommended)

```bash
npm install -g orchestrix-yuri
orchestrix-yuri install
orchestrix-yuri start --token "YOUR_BOT_TOKEN"   # first time, saves token
orchestrix-yuri start                              # from now on
```

### Method B: From source

```bash
git clone https://github.com/dorayo/orchestrix-yuri.git
cd orchestrix-yuri
npm install
node bin/install.js install
node bin/serve.js --token "YOUR_BOT_TOKEN"
```

### What `install` does

- Copies the Yuri skill to `~/.claude/skills/yuri/`
- Initializes global memory at `~/.yuri/` (identity, boss profile, portfolio, focus, wisdom)
- Writes a bootstrap signal so Yuri greets you on first interaction

## CLI Commands

```bash
orchestrix-yuri install                # Install Yuri skill + global memory
orchestrix-yuri start                  # Start the Channel Gateway
orchestrix-yuri start --token TOKEN    # Start & save Telegram Bot token (first time)
orchestrix-yuri stop                   # Stop the running gateway
orchestrix-yuri status                 # Show gateway status + cost tracking
orchestrix-yuri --version              # Show version
```

## Usage

### Terminal Mode

In any Claude Code session:

```
/yuri
```

### Telegram Mode

| Command | Description |
|---------|-------------|
| `*create` | Create a new project |
| `*plan` | Start planning (runs in background, agents auto-chain) |
| `*develop` | Start development (4 agents run autonomously) |
| `*test` | Run smoke tests |
| `*deploy` | Deploy the project |
| `*status` | Show progress + cost tracking |
| `*projects` | List all registered projects |
| `*switch <name>` | Switch active project |
| `*cancel` | Stop running phase |
| `*resume` | Resume from last checkpoint |
| `*change "{desc}"` | Handle requirement change |

### Agent Interaction via Telegram

When a planning agent asks a question (e.g., PM asking to confirm features), Yuri bridges it to Telegram:

```
Yuri: "📋 PM is asking:
       Which features to include?
       1. User auth  2. Dashboard  3. API
       ↩️ Reply to this message to answer"

You reply: "1 and 2, skip 3"   ← forwarded to PM agent
```

**Normal messages** (not reply-to) always go to Yuri directly.

## Architecture

### Gateway Engine (claude-sdk)

Each Telegram message is processed via `claude -p --output-format json`:

- **First message**: `--system-prompt` injects Yuri persona (SKILL.md) + L1 memory + channel instructions
- **Subsequent**: `--resume SESSION_ID` preserves conversation context
- **Output**: Structured JSON with `result` (clean text), `session_id`, `total_cost_usd`

### Async Phase Orchestration

`*plan` and `*develop` run as **Node.js background tasks** (not inside a `claude -p` call):

```
*plan → PhaseOrchestrator.startPlan() → instant reply
         ↓
  setInterval(30s) polls tmux agent → detects completion
         ↓
  starts next agent → proactive Telegram notification
         ↓
  user asks anything → normal Claude response (not blocked)
```

tmux is used **only for multi-agent orchestration** (plan/develop), not for the gateway itself.

### Memory System (4 layers)

```
L1 Global (~/.yuri/)           — Yuri identity, boss profile, portfolio, focus
L2 Project ({project}/.yuri/)  — Project identity, knowledge, decisions
L3 Phase State (state/)        — Per-phase operational status
L4 Events (timeline/)          — Append-only event history
```

**Reflect Engine**: Signals detected from user messages (preferences, identity, priorities) are written to `inbox.jsonl`, then processed by `reflect.js` into the corresponding YAML files before each Claude call.

### Context Management

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` triggers auto-compact at 80%
- Proactive `/compact` every 50 messages
- L1 hash tracking: when memory changes, a `[CONTEXT UPDATE]` prefix is injected into the next message

### File Structure

```
orchestrix-yuri/
├── bin/
│   ├── install.js              # CLI entry (install/start/stop/status)
│   ├── serve.js                # Gateway launcher
│   ├── stop.js                 # PID-based stop
│   └── status.js               # Gateway + cost status
├── lib/
│   ├── installer.js            # Global install logic
│   ├── migrate.js              # v1 → v2 memory migration
│   └── gateway/
│       ├── index.js             # startGateway()
│       ├── config.js            # Config loading + defaults
│       ├── router.js            # Message routing, phase detection, signal detection
│       ├── binding.js           # Owner authentication
│       ├── history.js           # Chat history (JSONL)
│       ├── log.js               # Colored terminal logging
│       ├── channels/
│       │   └── telegram.js      # grammy adapter (placeholder + edit pattern)
│       └── engine/
│           ├── claude-sdk.js    # Claude -p JSON engine + session management
│           ├── phase-orchestrator.js  # Background plan/develop execution
│           ├── reflect.js       # Inbox signal processing → YAML memory
│           └── tmux-utils.js    # Shared tmux operations
└── skill/
    ├── SKILL.md                 # Yuri persona + tmux command rules
    ├── tasks/                   # Phase workflow instructions
    ├── scripts/                 # Shell scripts (tmux, monitoring)
    ├── templates/               # Memory schema
    ├── data/                    # Decision rules, signal taxonomy
    └── resources/               # MCP config, hooks, tmux scripts
```

### tmux Sessions (for agent orchestration)

| Session | Purpose | Windows |
|---------|---------|---------|
| `op-{project}` | Planning phase | One per agent |
| `orchestrix-{repo-id}` | Development phase | 4 fixed (Architect, SM, Dev, QA) |

## Change Management

| Scope | Action |
|-------|--------|
| Small (≤5 files) | Dev `*solo` directly |
| Medium | PO `*route-change` → standard workflow |
| Large | Pause dev, partial re-plan |
| New iteration | PM `*start-iteration` → plan → dev → test |

## Troubleshooting

```bash
# Check prerequisites
tmux -V && which claude && node -v

# View gateway logs
orchestrix-yuri start 2>&1 | tee gateway.log

# Check status + cost
orchestrix-yuri status

# Stop the gateway
orchestrix-yuri stop

# Check running tmux sessions (plan/develop phases)
tmux ls

# Peek into a planning agent
tmux attach -t op-myproject

# Peek into dev agents
tmux attach -t orchestrix-myproject
```

## License

MIT
