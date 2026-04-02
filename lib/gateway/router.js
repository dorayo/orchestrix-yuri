'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { ChatHistory } = require('./history');
const { OwnerBinding } = require('./binding');
const engine = require('./engine/claude-sdk');
const { runReflect } = require('./engine/reflect');
const { PhaseOrchestrator } = require('./engine/phase-orchestrator');
const { Dispatcher } = require('./engine/dispatcher');
const { log } = require('./log');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');

// ── Phase command patterns ─────────────────────────────────────────────────────

const PHASE_COMMANDS = {
  plan:     /^\*plan\b/i,
  develop:  /^\*develop\b/i,
  test:     /^\*test\b/i,
  change:   /^\*change\s+(.+)/i,
  iterate:  /^\*iterate\b/i,
  deploy:   /^\*deploy\b/i,
  cancel:   /^\*cancel\b/i,
};

const META_COMMANDS = {
  help:     /^\*help\b/i,
  projects: /^\*projects\b/i,
  switch:   /^\*switch\s+(.+)/i,
};

const STATUS_PATTERNS = [
  /^\*status\b/i,
  /进度|状态|怎么样了|到哪了/,
  /\bstatus\b|\bprogress\b/i,
];

/**
 * Message router with five-engine orchestration + async phase execution.
 */
class Router {
  constructor(config) {
    this.config = config;
    this.history = new ChatHistory({
      storageDir: config.chat_history.storage,
      maxMessages: config.chat_history.max_messages,
    });
    this.bindings = {
      telegram: new OwnerBinding({ channelType: 'telegram' }),
      feishu: new OwnerBinding({ channelType: 'feishu' }),
    };
    this.processing = new Set();
    this._ownerChatId = null;
    this._ownerChannelType = null;
    this._sendCallbacks = {};   // keyed by channelType
    this._ownerChatIds = {};    // keyed by channelType → chatId (for broadcast)

    // Phase orchestrator — runs long operations in background
    this.orchestrator = new PhaseOrchestrator({
      config: config.engine,
      onProgress: (msg) => this._sendProactive(msg),
      onComplete: (phase, summary) => this._sendProactive(summary),
      onError: (phase, err) => this._sendProactive(`❌ Phase ${phase} error: ${err}`),
      onQuestionAsked: (text) => this._sendProactiveWithId(text),
    });

    // Auto-recover any in-progress phase from previous gateway run
    const projectRoot = engine.resolveProjectRoot();
    if (projectRoot) {
      this.orchestrator.tryRecover(projectRoot);
    }

    // Dispatcher: persistent Claude agent for NL intent classification
    this.dispatcher = new Dispatcher(config);
    this.dispatcher.start().catch((err) => log.warn(`Dispatcher start failed: ${err.message}`));

    // Independent progress reporter: sends periodic status card
    // when dev phase is active (detected from focus.yaml + tmux),
    // regardless of whether orchestrator is tracking it.
    this._reportTimer = null;
    this._startAutoReporter(config);
  }

  /**
   * Start an independent timer that checks if dev phase is running
   * and sends a progress card periodically.
   */
  _startAutoReporter(config) {
    const interval = (config.engine && config.engine.report_interval) || 1800000; // 30 min
    this._reportTimer = setInterval(() => {
      // Skip if orchestrator is already reporting (avoid duplicates)
      if (this.orchestrator.isRunning()) return;

      // Check if dev phase is active
      const projectRoot = engine.resolveProjectRoot();
      if (!projectRoot) return;

      const focusPath = path.join(projectRoot, '.yuri', 'focus.yaml');
      if (!fs.existsSync(focusPath)) return;

      try {
        const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
        const phaseNum = parseInt(focus.phase, 10);

        if (phaseNum === 3) {
          // Skip if dev phase already complete
          const phase3Path = path.join(projectRoot, '.yuri', 'state', 'phase3.yaml');
          if (fs.existsSync(phase3Path)) {
            const phase3 = yaml.load(fs.readFileSync(phase3Path, 'utf8')) || {};
            if (phase3.status === 'complete') return;
          }

          // Check tmux session is alive
          const { execSync } = require('child_process');
          const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' }).trim();
          if (!sessions.split('\n').some((s) => s.startsWith('orchestrix-'))) return;

          const card = this._buildStatusCard(projectRoot, focus);
          if (card) {
            log.router('Auto-reporting dev progress');
            this._sendProactive(card);
          }
        } else if (phaseNum === 4) {
          // Skip if test phase already complete
          const phase4Path = path.join(projectRoot, '.yuri', 'state', 'phase4.yaml');
          if (!fs.existsSync(phase4Path)) return;
          const phase4 = yaml.load(fs.readFileSync(phase4Path, 'utf8')) || {};
          if (phase4.status === 'complete' || phase4.status === 'complete_with_failures') return;

          const card = this._buildTestStatusCard(projectRoot);
          if (card) {
            log.router('Auto-reporting test progress');
            this._sendProactive(card);
          }
        }
      } catch { /* silent */ }
    }, interval);
  }

  /**
   * Register a proactive send callback for a channel type.
   */
  setSendCallback(channelType, callback) {
    if (channelType) {
      this._sendCallbacks[channelType] = callback;
    } else {
      // Legacy: if no channelType, store as 'default'
      this._sendCallbacks._default = callback;
    }
  }

  /**
   * Broadcast a proactive message to ALL bound channels.
   * Used for progress reports, phase completion, errors.
   */
  _sendProactive(text) {
    for (const [channelType, cb] of Object.entries(this._sendCallbacks)) {
      const chatId = this._ownerChatIds[channelType];
      if (cb && chatId) {
        cb(chatId, text).catch((err) => {
          log.warn(`Proactive send to ${channelType} failed: ${err.message}`);
        });
      }
    }
  }

  /**
   * Send a proactive message to the PRIMARY channel and return { messageId }.
   * Used for agent question bridging (needs single messageId for reply-to tracking).
   */
  async _sendProactiveWithId(text) {
    // Send to primary channel (for reply-to tracking)
    const primaryCb = this._ownerChannelType && this._sendCallbacks[this._ownerChannelType];
    const primaryChatId = this._ownerChatId;
    let result = null;

    if (primaryCb && primaryChatId) {
      try {
        result = await primaryCb(primaryChatId, text);
      } catch (err) {
        log.warn(`Proactive send failed: ${err.message}`);
      }
    }

    // Also broadcast to other channels (no messageId needed)
    for (const [channelType, cb] of Object.entries(this._sendCallbacks)) {
      if (channelType === this._ownerChannelType) continue;
      const chatId = this._ownerChatIds[channelType];
      if (cb && chatId) {
        cb(chatId, text).catch(() => {});
      }
    }

    return result;
  }

  /**
   * Handle an incoming channel message.
   */
  async handleMessage(msg) {
    // ═══ AUTH ═══
    const binding = this.bindings[msg.channelType];
    if (!binding) return { text: '❌ Unsupported channel type.' };

    const authResult = binding.check(msg.chatId);
    if (!authResult.allowed) return { text: '🔒 Unauthorized. This bot is private.' };

    if (authResult.firstBind) {
      log.router(`First bind: ${msg.channelType} chat ${msg.chatId} (${msg.userName})`);
    }

    // Store owner info for proactive messaging (per channel for broadcast)
    if (!this._ownerChatIds[msg.channelType]) {
      this._ownerChatIds[msg.channelType] = msg.chatId;
    }
    if (!this._ownerChatId) {
      this._ownerChatId = msg.chatId;
      this._ownerChannelType = msg.channelType;
    }

    // Handle /start
    if (msg.text === '/start') {
      if (authResult.firstBind) {
        return { text: '🚀 Welcome! You are now bound as the owner of this Yuri instance.\n\nSend me any message to interact with your projects.' };
      }
      return { text: '🚀 Yuri is ready. Send me any message to interact with your projects.' };
    }

    // ═══ SLASH → STAR conversion ═══
    // Telegram/Feishu users type /status, /help, etc. via bot menu.
    // Convert /command to *command so the router's pattern matching works.
    // Excludes /start (handled above) and /o, /clear (Claude Code commands).
    if (msg.text.startsWith('/') && !msg.text.startsWith('/start') && !msg.text.startsWith('/o') && !msg.text.startsWith('/clear')) {
      msg.text = '*' + msg.text.slice(1);
    }

    // ═══ STATUS QUERY — always allowed, even during processing ═══
    if (this._isStatusQuery(msg.text)) {
      return this._handleStatusQuery(msg);
    }

    // ═══ META COMMANDS — *help, *projects, *switch (always allowed) ═══
    if (META_COMMANDS.help.test(msg.text.trim())) {
      return { text: this._buildHelpText() };
    }
    if (META_COMMANDS.projects.test(msg.text.trim())) {
      return this._handleProjects(msg);
    }
    const switchMatch = msg.text.trim().match(META_COMMANDS.switch);
    if (switchMatch) {
      return this._handleSwitch(switchMatch[1].trim(), msg);
    }

    // ═══ AGENT REPLY — user replied to an agent question notification ═══
    if (msg.replyToMessageId && this.orchestrator.isWaitingForInput()) {
      const waitingId = this.orchestrator.getWaitingMessageId();
      if (waitingId && msg.replyToMessageId === waitingId) {
        const relayed = this.orchestrator.relayUserInput(msg.text);
        if (relayed) {
          return { text: '✅ Reply sent to agent. Resuming...' };
        }
      }
    }

    // ═══ CANCEL — stop running phase ═══
    if (PHASE_COMMANDS.cancel.test(msg.text.trim())) {
      if (this.orchestrator.isRunning()) {
        this.orchestrator.cancel();
        return { text: '🛑 Phase cancelled.' };
      }
      return { text: 'No phase is running.' };
    }

    // ═══ PHASE COMMANDS — delegate to orchestrator (non-blocking) ═══
    const phaseCmd = this._detectPhaseCommand(msg.text);
    if (phaseCmd) {
      return this._handlePhaseCommand(phaseCmd, msg);
    }

    // ═══ DISPATCHER CLASSIFY — NL intent detection via persistent Claude agent ═══
    {
      // Inject last assistant response as context for the dispatcher
      const lastReply = this.history.getLastAssistantMessage(msg.chatId);
      const contextText = lastReply
        ? `[CONTEXT] Previous assistant response: ${lastReply.slice(0, 300)}\n\nUser message: ${msg.text}`
        : msg.text;

      let classified = null;
      if (this.dispatcher) {
        try {
          classified = await this.dispatcher.classify(contextText);
          log.router(`Dispatcher: ${classified.action} ← "${msg.text.slice(0, 50)}..." (${classified.reasoning})`);
        } catch (err) {
          log.warn(`Dispatcher classify failed: ${err.message}`);
        }
      }

      // If dispatcher unavailable or failed, default to 'change' for work-like messages
      if (!classified) {
        classified = { action: 'change', description: msg.text, reasoning: 'dispatcher unavailable, defaulting to change' };
        log.router(`Dispatcher unavailable, defaulting to change for: "${msg.text.slice(0, 50)}..."`);
      }

      if (classified.action !== 'conversation') {
        try {
          const intentResult = await this._executeClassifiedIntent(classified, msg);
          if (intentResult) return intentResult;
        } catch (err) {
          log.warn(`Intent execution failed: ${err.message}`);
          // Fall through to conversation
        }
      }
    }

    // ═══ NORMAL MESSAGE — conversation via Claude ═══
    if (this.processing.has(msg.chatId)) {
      return { text: '⏳ Still processing your previous message. Please wait.' };
    }
    this.processing.add(msg.chatId);

    try {
      return await this._processMessage(msg);
    } finally {
      this.processing.delete(msg.chatId);
    }
  }

  // ── Dispatcher Intent Execution ─────────────────────────────────────────────

  async _executeClassifiedIntent(classified, msg) {
    const projectRoot = engine.resolveProjectRoot();
    if (!projectRoot) {
      return { text: '❌ No active project. Run `/yuri *create` in your terminal first.' };
    }

    this.history.append(msg.chatId, 'user', msg.text);

    switch (classified.action) {
      case 'bugfix': {
        const desc = classified.description || msg.text;
        const response = this.orchestrator.startQuickFix(projectRoot, desc);
        this.history.append(msg.chatId, 'assistant', response.slice(0, 2000));
        this._updateGlobalFocus(msg, projectRoot);
        return { text: response };
      }
      case 'change': {
        const desc = classified.description || msg.text;
        // Direct agent routing: user explicitly names an agent → skip scope/PO
        const directResult = await this._tryDirectAgentRoute(msg, projectRoot, desc);
        if (directResult) return directResult;
        msg.text = `*change ${desc}`;
        return this._handleChangeCommand(msg, projectRoot);
      }
      case 'plan':
      case 'develop':
      case 'test':
      case 'iterate':
      case 'deploy':
        return this._handlePhaseCommand(classified.action, msg);
      case 'status': {
        // Agent-specific or decision queries need Claude reasoning with tmux context,
        // not a canned status card. Fall through to conversation handler.
        const agentRe = /\b(sm|architect|dev|qa|po|pm|ux)\b/i;
        const decisionRe = /决策|决定|确认|需要我|应该|接着|下一步|然后呢|干啥|干什么|block|decide|should|next|what now/i;
        if (agentRe.test(msg.text) || decisionRe.test(msg.text)) {
          return null; // → conversation handler (Claude with tmux context)
        }
        return this._handleStatusQuery(msg);
      }
      default:
        return null;
    }
  }

  // ── Phase Command Handling ───────────────────────────────────────────────────

  _detectPhaseCommand(text) {
    const trimmed = text.trim();
    for (const [phase, re] of Object.entries(PHASE_COMMANDS)) {
      if (phase === 'cancel') continue; // handled separately
      if (re.test(trimmed)) return phase;
    }
    return null;
  }

  async _handlePhaseCommand(phase, msg) {
    const projectRoot = engine.resolveProjectRoot();
    if (!projectRoot) {
      return { text: '❌ No active project found. Run `/yuri *create` in your terminal first.' };
    }

    let response;
    switch (phase) {
      case 'plan':
        response = this.orchestrator.startPlan(projectRoot);
        break;
      case 'develop':
        response = this.orchestrator.startDevelop(projectRoot);
        break;
      case 'test':
        response = this.orchestrator.startTest(projectRoot);
        break;
      case 'change':
        return this._handleChangeCommand(msg, projectRoot);
      case 'iterate':
        response = this.orchestrator.startIterate(projectRoot);
        break;
      case 'deploy':
        return this._processMessageDirect(msg);
      default:
        response = `Unknown phase: ${phase}`;
    }

    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', response.slice(0, 2000));
    this._updateGlobalFocus(msg, projectRoot);

    return { text: response };
  }

  /**
   * Direct agent routing: when user explicitly names a planning or dev agent,
   * skip scope assessment and PO routing — send the instruction directly.
   * Returns null if no agent match (caller should fall through to normal change flow).
   */
  async _tryDirectAgentRoute(msg, projectRoot, description) {
    // Agent name patterns → { session type, agent slug for /o, window }
    // Planning agents all use window 0 (ensure-session.sh only creates one window).
    // Dev agents use their fixed windows (start-orchestrix.sh creates all 4).
    const AGENT_MAP = {
      // Planning session agents (all window 0)
      'analyst':   { session: 'planning', slug: 'analyst', window: 0 },
      'pm':        { session: 'planning', slug: 'pm', window: 0 },
      'ux-expert': { session: 'planning', slug: 'ux-expert', window: 0 },
      'ux':        { session: 'planning', slug: 'ux-expert', window: 0 },
      'po':        { session: 'planning', slug: 'po', window: 0 },
      // Dev session agents (fixed windows from start-orchestrix.sh)
      'architect': { session: 'dev', slug: 'architect', window: 0 },
      'sm':        { session: 'dev', slug: 'sm', window: 1 },
      'dev':       { session: 'dev', slug: 'dev', window: 2 },
      'qa':        { session: 'dev', slug: 'qa', window: 3 },
    };

    // Match agent name in user message (case-insensitive, word boundary)
    const text = msg.text.toLowerCase();
    let matched = null;
    for (const [name, info] of Object.entries(AGENT_MAP)) {
      if (text.includes(name)) {
        // Prefer longer match (ux-expert over ux)
        if (!matched || name.length > matched.name.length) {
          matched = { name, ...info };
        }
      }
    }
    if (!matched) return null;

    // Guard: don't hijack if orchestrator is busy with something else
    if (this.orchestrator.isRunning()) {
      return null; // let normal flow handle it
    }

    log.router(`Direct agent route: ${matched.slug} (${matched.session} session, window ${matched.window})`);

    try {
      const { execSync } = require('child_process');
      const scriptPath = path.join(os.homedir(), '.claude', 'skills', 'yuri', 'scripts', 'ensure-session.sh');
      const result = execSync(`bash "${scriptPath}" ${matched.session} "${projectRoot}"`, {
        encoding: 'utf8', timeout: 60000,
      }).trim();
      const lines = result.split('\n');
      const session = lines[lines.length - 1].trim();

      const tmx = require('./engine/tmux-utils');
      tmx.sendKeysWithEnter(session, matched.window, '/clear');
      execSync('sleep 2');
      tmx.sendKeysWithEnter(session, matched.window, `/o ${matched.slug}`);
      execSync('sleep 12');

      // Clean description: strip [CONTEXT] prefix injected by dispatcher
      let cleanDesc = description;
      const ctxMatch = cleanDesc.match(/\[CONTEXT\].*?(?:User message:\s*)?(.+)/s);
      if (ctxMatch) cleanDesc = ctxMatch[1].trim();
      if (!cleanDesc) cleanDesc = description;

      const safeDesc = cleanDesc.replace(/"/g, '\\"');
      tmx.sendKeysWithEnter(session, matched.window, safeDesc);

      // Set up polling via orchestrator (reuses change/small flow)
      this.orchestrator._projectRoot = projectRoot;
      this.orchestrator._phase = 'change';
      this.orchestrator._session = session;
      this.orchestrator._lastHash = '';
      this.orchestrator._stableCount = 0;
      this.orchestrator._step = 0;
      this.orchestrator._changeContext = { scope: 'direct', description, agent: matched.slug };
      const pollInterval = this.orchestrator.config.phase_poll_interval || 30000;
      this.orchestrator._timer = setInterval(() => {
        // Poll the specific agent window
        if (this.orchestrator._phase !== 'change') return;
        if (!tmx.hasSession(session)) {
          this.orchestrator._handleError('change', `${matched.slug} tmux session died`);
          return;
        }
        const check = tmx.checkCompletion(session, matched.window, this.orchestrator._lastHash);
        if (check.status === 'complete' || (check.status === 'stable' && ++this.orchestrator._stableCount >= 3)) {
          if (this.orchestrator._timer) { clearInterval(this.orchestrator._timer); this.orchestrator._timer = null; }
          this.orchestrator._phase = null;
          this.orchestrator._changeContext = null;

          // Capture agent output for a meaningful completion summary
          let summary = `✅ **${matched.slug}** completed the task.`;
          try {
            const pane = tmx.capturePane(session, matched.window, 30);
            const outputLines = pane.split('\n').filter((l) => l.trim() && !/^❯/.test(l.trim()));
            if (outputLines.length > 0) {
              const tail = outputLines.slice(-8).map((l) => l.trim()).join('\n');
              summary += `\n\n📋 Output (last lines):\n${tail}`;
            }
          } catch { /* ok */ }
          summary += `\n\n💡 Suggested next: review the output, then tell me what to do next (e.g., "让 dev 开始实现" or "*develop").`;

          this.orchestrator.onComplete('change', summary);
          return;
        }
        if (check.status !== 'stable') { this.orchestrator._stableCount = 0; this.orchestrator._lastHash = check.hash || ''; }
        else { this.orchestrator._lastHash = check.hash; }
      }, pollInterval);

      this.history.append(msg.chatId, 'user', msg.text);
      const reply = `🎯 Direct → **${matched.slug}**\n\n"${cleanDesc.slice(0, 120)}"\n\nI'll notify you when done.`;
      this.history.append(msg.chatId, 'assistant', reply);
      this._updateGlobalFocus(msg, projectRoot);

      return { text: reply };
    } catch (err) {
      log.warn(`Direct agent route failed: ${err.message}`);
      return null; // fall through to normal change flow
    }
  }

  /**
   * Handle *change command in two steps:
   * Step 1: Claude assesses the scope (small/medium/large) — quick claude -p call
   * Step 2: Orchestrator executes the change in tmux background
   */
  async _handleChangeCommand(msg, projectRoot) {
    // Extract description from "*change description here"
    const match = msg.text.trim().match(/^\*change\s+(.+)/i);
    const description = match ? match[1].replace(/^["']|["']$/g, '') : '';

    if (!description) {
      return { text: '❌ Usage: *change "description of the change"\n\nExample: *change "Add dark mode toggle to settings page"' };
    }

    // Step 1: Ask Claude to assess scope
    this.history.append(msg.chatId, 'user', msg.text);
    log.router(`Change request: "${description.slice(0, 80)}..." — assessing scope...`);

    const scopePrompt = `You are assessing a change request for a software project.

Change description: "${description}"

Based on the description, classify the scope as one of:
- **small**: ≤5 files affected, no architectural changes, no new dependencies (e.g., UI tweak, bug fix, small feature)
- **medium**: Cross-component change, needs PO routing and possibly architect review (e.g., new API endpoint, refactoring a module)
- **large**: Cross-module/database/security change, needs full re-planning (e.g., auth system rewrite, new microservice)

Reply with ONLY one word: small, medium, or large. Nothing else.`;

    const scopeResult = await engine.callClaude({
      prompt: scopePrompt,
      cwd: projectRoot,
      engineConfig: this.config.engine,
      timeout: 30000, // quick assessment
    });

    const scopeRaw = (scopeResult.reply || '').trim().toLowerCase();
    const scope = ['small', 'medium', 'large'].find((s) => scopeRaw.includes(s)) || 'medium';

    log.router(`Change scope assessed: ${scope}`);

    // Step 2: Execute via orchestrator
    const response = this.orchestrator.startChange(projectRoot, scope, description);

    this.history.append(msg.chatId, 'assistant', response.slice(0, 2000));
    this._updateGlobalFocus(msg, projectRoot);

    return { text: `📋 Scope: **${scope}**\n\n${response}` };
  }

  // ── Status Query ─────────────────────────────────────────────────────────────

  _isStatusQuery(text) {
    return STATUS_PATTERNS.some((re) => re.test(text.trim()));
  }

  _handleStatusQuery(msg) {
    const parts = [];

    // Orchestrator status (if actively tracking)
    if (this.orchestrator.isRunning()) {
      const status = this.orchestrator.getStatus();
      parts.push(status.message);
    }

    // Read project state — generate progress card even if orchestrator isn't tracking
    const projectRoot = engine.resolveProjectRoot();
    if (projectRoot && !this.orchestrator.isRunning()) {
      const focusPath = path.join(projectRoot, '.yuri', 'focus.yaml');
      if (fs.existsSync(focusPath)) {
        try {
          const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};

          const phaseNum = parseInt(focus.phase, 10);

          // Dev phase: generate progress card (no phase3.yaml dependency)
          if (phaseNum === 3) {
            try {
              const card = this._buildStatusCard(projectRoot, focus);
              if (card) parts.push(card);
            } catch (err) {
              log.warn(`Progress card failed: ${err.message}`);
            }
          }

          // Test phase: generate test progress card from phase4.yaml
          if (phaseNum === 4 && parts.length === 0) {
            try {
              const card = this._buildTestStatusCard(projectRoot);
              if (card) parts.push(card);
            } catch (err) {
              log.warn(`Test progress card failed: ${err.message}`);
            }
          }

          // Fallback or non-dev phase
          if (parts.length === 0) {
            if (focus.pulse) parts.push(`Pulse: ${focus.pulse}`);
            if (focus.step) parts.push(`Step: ${focus.step}`);
          }
        } catch { /* ok */ }
      }
    }

    // Cost tracking
    const usage = engine.getUsageStats();
    if (usage.totalCost > 0) {
      parts.push(`\n💰 Cost: $${usage.totalCost.toFixed(4)} | ${usage.messageCount} messages | ${(usage.totalDuration / 1000).toFixed(0)}s total`);
    }

    if (parts.length === 0) {
      parts.push('No active phase. Available commands: *plan, *develop, *test, *deploy, *projects, *switch');
    }

    this.history.append(msg.chatId, 'user', msg.text);
    const reply = parts.join('\n');
    this.history.append(msg.chatId, 'assistant', reply);

    return { text: reply };
  }

  // ── Normal Message Processing (via Claude) ───────────────────────────────────

  async _processMessage(msg) {
    try { runReflect(); } catch (err) { log.warn(`Reflect failed: ${err.message}`); }
    await this._runCatchUp();

    const projectRoot = engine.resolveProjectRoot();

    // Inject tmux pane context so Claude can see agent state
    let prompt = engine.composePrompt(msg.text);
    if (this.orchestrator.isRunning()) {
      const agentContext = this.orchestrator.captureCurrentAgentContext();
      if (agentContext) {
        prompt = `${agentContext}\n\n---\n\nUser message: ${msg.text}`;
      }
    } else if (projectRoot) {
      // Even without active orchestrator, check for live dev sessions
      const tmxContext = this._captureLiveDevContext(projectRoot);
      if (tmxContext) {
        prompt = `${tmxContext}\n\n---\n\nUser message: ${msg.text}`;
      }
    }

    log.router(`Processing: "${msg.text.slice(0, 80)}..." → cwd: ${projectRoot || '~'}`);
    const result = await engine.callClaude({
      prompt,
      cwd: projectRoot,
      engineConfig: this.config.engine,
      timeout: (this.config.engine && this.config.engine.conversation_timeout) || 90000,
    });

    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', result.reply.slice(0, 2000));
    this._detectSignals(msg, result.reply);
    this._updateGlobalFocus(msg, projectRoot);

    log.router(`Reply: "${result.reply.slice(0, 80)}..."`);
    return { text: result.reply };
  }

  /**
   * Process a message through Claude without the processing guard.
   * Used for phase commands that should be handled by Claude (test, deploy).
   */
  async _processMessageDirect(msg) {
    if (this.processing.has(msg.chatId)) {
      return { text: '⏳ Still processing your previous message. Please wait.' };
    }
    this.processing.add(msg.chatId);
    try {
      return await this._processMessage(msg);
    } finally {
      this.processing.delete(msg.chatId);
    }
  }

  // ── Catch-up ─────────────────────────────────────────────────────────────────

  async _runCatchUp() {
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    if (!fs.existsSync(focusPath)) return;

    const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
    if (!focus.updated_at) return;

    const gap = Date.now() - new Date(focus.updated_at).getTime();
    if (gap > 3600_000) {
      log.router(`Catch-up: ${Math.round(gap / 60000)}min idle. Refreshing portfolio.`);
      this._refreshPortfolioPulse();
    }
  }

  _refreshPortfolioPulse() {
    const registryPath = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
    if (!fs.existsSync(registryPath)) return;

    const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
    const projects = registry.projects || [];
    let changed = false;

    for (const project of projects) {
      if (project.status !== 'active') continue;
      if (!project.root || !fs.existsSync(project.root)) continue;

      const focusPath = path.join(project.root, '.yuri', 'focus.yaml');
      if (!fs.existsSync(focusPath)) continue;

      const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
      const newPulse = focus.pulse || `Phase ${focus.phase || '?'}`;
      if (project.pulse !== newPulse) {
        project.pulse = newPulse;
        project.phase = focus.phase || project.phase;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(registryPath, yaml.dump(registry, { lineWidth: -1 }));
    }
  }

  // ── Signal Detection ─────────────────────────────────────────────────────────

  static PRIORITY_PATTERNS = [
    /\b(focus\s+on|switch\s+to|prioritize)\b/i,
    /\b(pause|stop|halt)\s+(this|the|project|work|development)/i,
    /\b(urgent|deadline|asap)\b/i,
    /先搞|暂停\s*(这个|项目|开发)|不做了/,
  ];

  static PREFERENCE_PATTERNS = [
    /\b(from\s+now\s+on|going\s+forward|always|never)\b/i,
    /\b(don't|do\s+not|stop)\s+(use|do|write|send|make|add)/i,
    /\b(I\s+prefer|I\s+like|I\s+want\s+you\s+to)\b/i,
    /(别|不要)\s*\S+/,
    /以后/,
  ];

  static IDENTITY_PATTERNS = [
    /\b(I\s+am\s+a|I'm\s+a|my\s+role|my\s+job|I\s+work\s+(as|in|at|on))\b/i,
    /\b(my\s+name\s+is|I'm\s+called|call\s+me)\b/i,
    /我是|我叫|我的角色|我负责/,
  ];

  static RESPONSE_PREFERENCE_HINTS = [
    /I'll remember|noted|preference saved|got it/i,
    /记住了|已记录|偏好已/,
  ];

  static RESPONSE_IDENTITY_HINTS = [
    /your role|you mentioned you|your expertise|your name/i,
    /你的角色|你提到/,
  ];

  _detectSignals(msg, claudeReply) {
    const inboxPath = path.join(YURI_GLOBAL, 'inbox.jsonl');
    const signals = [];
    const text = msg.text;

    if (Router.PRIORITY_PATTERNS.some((re) => re.test(text))) {
      signals.push({ signal: 'priority_change', raw: text });
    }
    if (Router.PREFERENCE_PATTERNS.some((re) => re.test(text))) {
      signals.push({ signal: 'boss_preference', raw: text });
    }
    if (Router.IDENTITY_PATTERNS.some((re) => re.test(text))) {
      signals.push({ signal: 'boss_identity', raw: text });
    }

    if (claudeReply) {
      if (Router.RESPONSE_PREFERENCE_HINTS.some((re) => re.test(claudeReply))) {
        if (!signals.some((s) => s.signal === 'boss_preference')) {
          signals.push({ signal: 'boss_preference', raw: text });
        }
      }
      if (Router.RESPONSE_IDENTITY_HINTS.some((re) => re.test(claudeReply))) {
        if (!signals.some((s) => s.signal === 'boss_identity')) {
          signals.push({ signal: 'boss_identity', raw: text });
        }
      }
    }

    for (const sig of signals) {
      const entry = {
        ts: new Date().toISOString(),
        signal: sig.signal,
        raw: sig.raw.slice(0, 500),
        context: `channel:${msg.channelType}`,
        processed: false,
      };
      fs.appendFileSync(inboxPath, JSON.stringify(entry) + '\n');
    }

    if (signals.length > 0) {
      log.router(`Detected ${signals.length} signal(s): ${signals.map((s) => s.signal).join(', ')}`);
    }
  }

  // ── Multi-Project Commands ────────────────────────────────────────────────────

  _handleProjects(msg) {
    const registryPath = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
    if (!fs.existsSync(registryPath)) {
      return { text: 'No projects registered yet. Run `/yuri *create` in your terminal first.' };
    }

    const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
    const projects = registry.projects || [];
    if (projects.length === 0) {
      return { text: 'No projects registered yet. Run `/yuri *create` in your terminal first.' };
    }

    // Read active project
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    let activeId = '';
    if (fs.existsSync(focusPath)) {
      const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
      activeId = focus.active_project || '';
    }

    const statusIcons = { active: '✅', paused: '💤', maintenance: '🔧', archived: '📦' };
    const lines = projects.map((p, i) => {
      const icon = statusIcons[p.status] || '❓';
      const isCurrent = p.id === activeId ? ' ← current' : '';
      return `${i + 1}. **${p.name || p.id}** ${icon} ${p.status} (Phase ${p.phase || '?'}: ${p.pulse || '?'})${isCurrent}`;
    });

    const reply = `📂 **Projects**\n\n${lines.join('\n')}\n\nUse \`*switch <name>\` to change active project.`;
    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', reply);
    return { text: reply };
  }

  _handleSwitch(query, msg) {
    const registryPath = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
    if (!fs.existsSync(registryPath)) {
      return { text: '❌ No projects registered.' };
    }

    const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
    const projects = registry.projects || [];
    const q = query.toLowerCase();

    // Fuzzy match: exact id, exact name, prefix of id, prefix of name
    const match = projects.find((p) => p.id === q || (p.name && p.name.toLowerCase() === q))
      || projects.find((p) => p.id.startsWith(q) || (p.name && p.name.toLowerCase().startsWith(q)));

    if (!match) {
      return { text: `❌ No project matching "${query}". Use *projects to see available projects.` };
    }

    // Update focus
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    let focus = {};
    if (fs.existsSync(focusPath)) {
      focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
    }
    focus.active_project = match.id;
    focus.active_action = `switched to project: ${match.name || match.id}`;
    focus.updated_at = new Date().toISOString();
    fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));

    // Clear Claude session so next message gets fresh system prompt for new project
    engine.clearSessionState();

    const reply = `✅ Switched to **${match.name || match.id}** (Phase ${match.phase || '?'}: ${match.pulse || '?'})`;
    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', reply);
    log.router(`Project switched to: ${match.id}`);
    return { text: reply };
  }

  // ── Progress Card (self-contained, no phase3.yaml dependency) ──────────────

  _buildStatusCard(projectRoot, focus) {
    const { execSync } = require('child_process');

    // 1. Scan stories via scan-stories.sh
    let byStatus = {};
    let totalPlanned = 0;   // total stories defined in epic YAMLs
    let createdStories = 0; // stories with files in docs/stories/
    let doneStories = 0;
    let totalEpics = 0;
    let currentEpic = 0;
    let currentStory = null;
    const scriptPath = path.join(os.homedir(), '.claude', 'skills', 'yuri', 'scripts', 'scan-stories.sh');
    if (fs.existsSync(scriptPath)) {
      const output = execSync(`bash "${scriptPath}" "${projectRoot}"`, { encoding: 'utf8', timeout: 10000 }).trim();
      if (output && output !== 'NO_STORIES_DIR') {
        for (const line of output.split('\n')) {
          const colonIdx = line.indexOf(':');
          if (colonIdx < 0) continue;
          const key = line.slice(0, colonIdx);
          const val = line.slice(colonIdx + 1).trim();

          if (key === 'Total') totalPlanned = parseInt(val, 10) || 0;
          else if (key === 'Created') createdStories = parseInt(val, 10) || 0;
          else if (key === 'Epics') totalEpics = parseInt(val, 10) || 0;
          else if (key === 'CurrentEpic') currentEpic = parseInt(val, 10) || 0;
          else if (key === 'CurrentStory') currentStory = val || null;
          else if (key === 'StatusDone') { doneStories++; byStatus.Done = (byStatus.Done || 0) + 1; }
          else if (key === 'StatusInProgress') byStatus.InProgress = (byStatus.InProgress || 0) + 1;
          else if (key === 'StatusReview') byStatus.Review = (byStatus.Review || 0) + 1;
          else if (key === 'StatusBlocked') byStatus.Blocked = (byStatus.Blocked || 0) + 1;
          else if (key === 'StatusApproved') byStatus.Approved = (byStatus.Approved || 0) + 1;
          else if (key === 'StatusDraft') byStatus.Draft = (byStatus.Draft || 0) + 1;
          else if (key === 'StatusNoStatus') byStatus.NoStatus = (byStatus.NoStatus || 0) + 1;
          else if (key === 'StatusOther') byStatus.Other = (byStatus.Other || 0) + 1;
        }
      }
    }

    // 2. Find tmux dev session
    let devSession = null;
    try {
      const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' }).trim();
      // Match orchestrix-{project-name} pattern
      const projectName = path.basename(projectRoot).toLowerCase();
      devSession = sessions.split('\n').find((s) =>
        s.startsWith('orchestrix-') && s.toLowerCase().includes(projectName)
      ) || sessions.split('\n').find((s) => s.startsWith('orchestrix-'));
    } catch { /* no tmux */ }

    // 3. Detect current agent from tmux
    let currentAgent = null;
    let currentWindow = null;
    // currentStory already set from scan-stories.sh above
    const tmx = require('./engine/tmux-utils');
    if (devSession && tmx.hasSession(devSession)) {
      const windowNames = ['Architect', 'SM', 'Dev', 'QA'];
      // Detect active agent: an agent showing the Command table or
      // "How can I assist" is IDLE (waiting). A window WITHOUT these
      // patterns is actively executing a task.
      const idlePatterns = /Command.*Description/i;

      // Pass 1: find window with spinner (definitely working)
      for (let w = 0; w < 4; w++) {
        const pane = tmx.capturePane(devSession, w, 10);
        if (/●|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(pane)) {
          currentAgent = windowNames[w];
          currentWindow = w;
          break;
        }
      }

      // Pass 2: find window that is NOT idle (no Command table)
      if (!currentAgent) {
        for (let w = 0; w < 4; w++) {
          const pane = tmx.capturePane(devSession, w, 15);
          const hasContent = pane.split('\n').filter((l) => l.trim()).length > 2;
          if (hasContent && !idlePatterns.test(pane)) {
            currentAgent = windowNames[w];
            currentWindow = w;
            break;
          }
        }
      }
    }

    // 4. Count epics from docs/prd/ (epic YAML files)
    if (totalEpics === 0) {
      const prdDir = path.join(projectRoot, 'docs', 'prd');
      if (fs.existsSync(prdDir)) {
        try {
          const epicNums = fs.readdirSync(prdDir)
              .map((f) => { const m = f.match(/^epic-(\d+)/i); return m ? parseInt(m[1], 10) : 0; })
              .filter((n) => n > 0);
            totalEpics = epicNums.length > 0 ? Math.max(...epicNums) : 0;
        } catch { /* ok */ }
      }
    }

    // 5. Running time
    const startedAt = focus.updated_at ? new Date(focus.updated_at).getTime() : Date.now();
    const runMs = Date.now() - startedAt;
    const runMin = Math.floor(runMs / 60000);
    const elapsed = runMin < 60 ? `${runMin}min` : `${Math.floor(runMin / 60)}h ${runMin % 60}min`;

    // 6. Build card
    const total = totalPlanned || createdStories; // prefer planned, fallback to created
    const pct = total > 0 ? Math.round(doneStories / total * 100) : 0;
    const barLen = 20;
    const filled = Math.round(pct / 100 * barLen);
    const bar = '▓'.repeat(filled) + '░'.repeat(barLen - filled);

    const lines = ['📊 **Dev Progress Report**', '━━━━━━━━━━━━━━━━━━━━━'];
    if (totalEpics > 0) {
      lines.push(`Epic: ${currentEpic}/${totalEpics}`);
    }
    lines.push(`Story: ${doneStories}/${total} done (${pct}%) | ${createdStories} created`);
    lines.push(`${bar} ${pct}%`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━');

    // Status breakdown
    const icons = { Done: '✅', InProgress: '🔄', Review: '👀', Blocked: '🚫', Approved: '📋', Draft: '📝', NoStatus: '❓', Other: '·' };
    const statusEntries = Object.entries(byStatus).filter(([, v]) => v > 0);
    if (statusEntries.length > 0) {
      for (const [s, n] of statusEntries) {
        lines.push(`${icons[s] || '·'} ${s}: ${n}`);
      }
      lines.push('━━━━━━━━━━━━━━━━━━━━━');
    }

    // Current story (from scan-stories.sh, overrides tmux detection)
    if (currentStory) {
      lines.push(`📝 Current: ${currentStory}`);
    }

    if (currentAgent) {
      lines.push(`🤖 Agent: ${currentAgent} (window ${currentWindow})`);
    } else if (devSession) {
      lines.push(`Session: ${devSession}`);
    }

    lines.push(`⏱ Running for ${elapsed}`);
    return lines.join('\n');
  }

  // ── Test Progress Card (from phase4.yaml, for *status when orchestrator is not tracking) ──

  _buildTestStatusCard(projectRoot) {
    const phase4Path = path.join(projectRoot, '.yuri', 'state', 'phase4.yaml');
    if (!fs.existsSync(phase4Path)) return null;

    const state = yaml.load(fs.readFileSync(phase4Path, 'utf8')) || {};
    if (!Array.isArray(state.epics) || state.epics.length === 0) return null;

    const total = state.epics.length;
    const passed = state.epics.filter((e) => e.status === 'passed').length;
    const failed = state.epics.filter((e) => e.status === 'failed').length;
    const tested = passed + failed;
    const pct = total > 0 ? Math.round((tested / total) * 100) : 0;

    const barTotal = 20;
    const filled = Math.round(pct / 100 * barTotal);
    const bar = '▓'.repeat(filled) + '░'.repeat(barTotal - filled) + ` ${pct}%`;

    const lines = [
      '🧪 **Test Phase Progress**',
      '',
      bar,
      '',
      `📊 Epics: ${tested}/${total} tested (✅ ${passed} passed, ❌ ${failed} failed)`,
      '',
      '📋 Results:',
    ];

    for (const epic of state.epics) {
      if (epic.status === 'passed') {
        lines.push(`  ✅ Epic ${epic.id} — passed (${epic.rounds || 0} round(s))`);
      } else if (epic.status === 'failed') {
        lines.push(`  ❌ Epic ${epic.id} — failed (${epic.rounds || 0} rounds)`);
      } else {
        lines.push(`  ⬜ Epic ${epic.id} — ${epic.status || 'pending'}`);
      }
    }

    if (state.status === 'complete' || state.status === 'complete_with_failures') {
      lines.push(`\n✅ Testing finished at ${state.completed_at || 'unknown'}`);
    }

    return lines.join('\n');
  }

  // ── Live Dev Context (for conversation when orchestrator is not tracking) ─────

  _captureLiveDevContext(projectRoot) {
    const { execSync } = require('child_process');
    const tmx = require('./engine/tmux-utils');
    try {
      const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' }).trim();
      const projectName = path.basename(projectRoot).toLowerCase();
      const devSession = sessions.split('\n').find((s) =>
        s.startsWith('orchestrix-') && s.toLowerCase().includes(projectName)
      ) || sessions.split('\n').find((s) => s.startsWith('orchestrix-'));
      if (!devSession || !tmx.hasSession(devSession)) return null;

      const windows = ['Architect', 'SM', 'Dev', 'QA'];
      const summaries = [];
      for (let w = 0; w < 4; w++) {
        const tail = tmx.capturePane(devSession, w, 10);
        const lines = tail.split('\n').filter((l) => l.trim());
        const last = lines.slice(-3).map((l) => l.trim().slice(0, 100)).join('\n    ');
        summaries.push(`  Window ${w} (${windows[w]}):\n    ${last || '(idle)'}`);
      }
      return `[LIVE DEV SESSION] ${devSession} (orchestrator not actively tracking)\n${summaries.join('\n')}`;
    } catch { return null; }
  }

  // ── Help ──────────────────────────────────────────────────────────────────────

  _buildHelpText() {
    return `🚀 **Yuri — Meta-Orchestrator**

**Project Lifecycle**
| Command | Description |
|---------|-------------|
| \`*plan\` | Start planning phase (6 agents sequentially, background) |
| \`*develop\` | Start development phase (4 agents with HANDOFF, background) |
| \`*test\` | Start smoke testing (QA per epic, auto fix-retest) |
| \`*deploy\` | Deploy the project |

**Change & Iteration**
| Command | Description |
|---------|-------------|
| \`*change "desc"\` | Handle a requirement change (auto scope assessment) |
| \`*iterate\` | Start new iteration (PM → agents → dev automation) |

**Monitoring**
| Command | Description |
|---------|-------------|
| \`*status\` | Show progress card (epic/story/agent/cost) |
| \`*cancel\` | Stop the running phase |
| \`*resume\` | Resume from last checkpoint |

**Portfolio**
| Command | Description |
|---------|-------------|
| \`*projects\` | List all registered projects |
| \`*switch <name>\` | Switch active project |
| \`*help\` | Show this help |

**Notes**
- \`*plan\`, \`*develop\`, \`*test\`, \`*change\`, \`*iterate\` run in background — you can chat normally while they execute
- Progress is reported every 30 minutes automatically
- Reply to agent question messages to answer them directly`;
  }

  _updateGlobalFocus(msg, projectRoot) {
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    if (!fs.existsSync(focusPath)) return;

    try {
      const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
      focus.active_action = `channel:${msg.channelType} — last msg: "${msg.text.slice(0, 60)}"`;
      focus.updated_at = new Date().toISOString();
      fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
    } catch (err) {
      log.warn(`Failed to update focus: ${err.message}`);
    }
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    if (this._reportTimer) clearInterval(this._reportTimer);
    this.orchestrator.shutdown();
    if (this.dispatcher) this.dispatcher.shutdown();
    if (engine.destroySession) engine.destroySession();
  }
}

module.exports = { Router };
