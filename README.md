# Orchestrix Yuri — Meta-Orchestrator

Yuri is a **Meta-Orchestrator** that takes natural language from users and autonomously drives all [Orchestrix](https://orchestrix-mcp.youlidao.ai) agents through the full project lifecycle.

```
User describes idea → Yuri drives: Create → Plan → Develop → Test → Deploy
```

## How It Works

Yuri is a [Claude Code skill](https://code.claude.com/docs/en/skills) + Channel Gateway. It can be used in two ways:

1. **Terminal mode** — activate `/yuri` inside any Claude Code session
2. **Telegram mode** — chat with Yuri via Telegram bot, backed by a persistent tmux Claude Code session

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
# Install globally
npm install -g orchestrix-yuri

# Initialize skill + global memory
orchestrix-yuri install

# Start Telegram gateway
orchestrix-yuri serve --telegram-token "YOUR_BOT_TOKEN"
```

### Method B: From source

```bash
git clone https://github.com/anthropics/orchestrix-yuri.git
cd orchestrix-yuri
npm install

# Initialize skill + global memory
node bin/install.js install

# Start Telegram gateway
node bin/serve.js --telegram-token "YOUR_BOT_TOKEN"
```

### What `install` does

- Copies the Yuri skill to `~/.claude/skills/yuri/`
- Initializes global memory at `~/.yuri/` (identity, boss profile, portfolio registry, focus, wisdom)
- Creates channel config at `~/.yuri/config/channels.yaml`

## Usage

### Terminal Mode

In any Claude Code session:

```
/yuri
```

Then either describe your project idea in natural language, or use a specific command:

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

### Telegram Mode

Start the gateway and chat with Yuri via your Telegram bot:

```bash
# With token as CLI argument
orchestrix-yuri serve --telegram-token "YOUR_BOT_TOKEN"

# Or configure in ~/.yuri/config/channels.yaml first
orchestrix-yuri serve
```

#### Channel Configuration

Edit `~/.yuri/config/channels.yaml`:

```yaml
server:
  port: 7890

channels:
  telegram:
    enabled: true
    token: "YOUR_BOT_TOKEN"
    mode: polling
    owner_chat_id: ""  # Auto-bound on first /start

engine:
  skill: yuri
  tmux_session: yuri-gateway
  startup_timeout: 30000
  poll_interval: 2000
  timeout: 300000
  autocompact_pct: 80
  compact_every: 50
```

#### First-time Telegram setup

1. Start the gateway: `orchestrix-yuri serve --telegram-token "YOUR_TOKEN"`
2. Open Telegram, find your bot, send `/start`
3. The first user to send `/start` becomes the owner (all others are rejected)
4. Send any message to interact with Yuri

## Architecture

### Persistent tmux Engine

The Telegram gateway runs Claude Code in a persistent tmux session (`yuri-gateway`), not as a one-shot subprocess. This means:

- **MCP servers connect once** and stay connected across messages
- **Conversation context is preserved** natively by Claude Code
- **No cold-start per message** — only the first message incurs startup latency

State detection uses Claude Code's TUI indicators:

| Symbol | State | Description |
|--------|-------|-------------|
| `○` | Idle | Waiting for input |
| `●` | Processing | Generating a response |
| `◐` | Approval | Permission prompt (auto-approved) |
| `[Verb]ed for Ns` | Complete | Response finished (e.g. "Baked for 31s") |

### Context Management (3-layer)

1. **CLAUDE.md persistence** — core instructions are written to project CLAUDE.md, which survives auto-compact
2. **Early auto-compact** — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80` triggers compaction at 80% (not the default 95%)
3. **Proactive /compact** — every 50 messages, a `/compact` is sent to keep context lean

### Memory System

Yuri maintains a four-layer global memory at `~/.yuri/`:

```
~/.yuri/
├── self.yaml                # Yuri identity
├── boss/
│   ├── profile.yaml         # Boss profile
│   └── preferences.yaml     # Boss preferences
├── portfolio/
│   ├── registry.yaml        # All projects (active/archived)
│   ├── priorities.yaml      # Portfolio priorities
│   └── relationships.yaml   # Project relationships
├── focus.yaml               # Current focus & state
├── config/
│   └── channels.yaml        # Gateway channel config
├── chat-history/            # JSONL per chat_id
├── inbox.jsonl              # Observation signals
└── wisdom/                  # Accumulated knowledge
```

### tmux Sessions

| Session | Purpose | Windows |
|---------|---------|---------|
| `yuri-gateway` | Telegram channel gateway | 1 (Claude Code interactive) |
| `op-{project}` | Planning phase | One per agent (Analyst, PM, UX, Architect, PO) |
| `orchestrix-{repo-id}` | Development phase | 4 fixed (Architect, SM, Dev, QA) |

### File Structure

```
orchestrix-yuri/
├── bin/
│   ├── install.js           # CLI entry (install / serve / migrate)
│   └── serve.js             # Gateway launcher
├── lib/
│   ├── installer.js         # Global install logic
│   ├── migrate.js           # v1 → v2 memory migration
│   └── gateway/
│       ├── index.js          # startGateway()
│       ├── config.js         # Config loading + defaults
│       ├── router.js         # Message routing + 5-engine orchestration
│       ├── binding.js        # Owner authentication
│       ├── history.js        # Chat history (JSONL)
│       ├── channels/
│       │   └── telegram.js   # grammy Telegram adapter
│       └── engine/
│           └── claude-tmux.js # Persistent tmux session engine
└── skill/
    ├── SKILL.md              # Agent persona
    ├── tasks/                # Phase workflow instructions
    ├── scripts/              # Shell scripts (tmux, monitoring)
    ├── templates/            # Memory schema
    ├── data/                 # Decision rules
    └── resources/            # MCP config, hooks, tmux scripts
```

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

## Troubleshooting

```bash
# Check prerequisites
tmux -V && which claude && node -v

# View gateway logs (all output goes to stdout)
orchestrix-yuri serve --telegram-token "..." 2>&1 | tee gateway.log

# Check if tmux session is alive
tmux ls

# Peek into the Claude Code session
tmux attach -t yuri-gateway

# Manual cleanup if session gets stuck
tmux kill-session -t yuri-gateway
```

## License

MIT
