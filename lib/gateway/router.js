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
const { log } = require('./log');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');

// ── Phase command patterns ─────────────────────────────────────────────────────

const PHASE_COMMANDS = {
  plan:    /^\*plan\b/i,
  develop: /^\*develop\b/i,
  test:    /^\*test\b/i,
  deploy:  /^\*deploy\b/i,
  cancel:  /^\*cancel\b/i,
};

const META_COMMANDS = {
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

    // ═══ STATUS QUERY — always allowed, even during processing ═══
    if (this._isStatusQuery(msg.text)) {
      return this._handleStatusQuery(msg);
    }

    // ═══ META COMMANDS — *projects, *switch (always allowed) ═══
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

    // ═══ NORMAL MESSAGE — goes through Claude ═══
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

  // ── Phase Command Handling ───────────────────────────────────────────────────

  _detectPhaseCommand(text) {
    const trimmed = text.trim();
    for (const [phase, re] of Object.entries(PHASE_COMMANDS)) {
      if (phase === 'cancel') continue; // handled separately
      if (re.test(trimmed)) return phase;
    }
    return null;
  }

  _handlePhaseCommand(phase, msg) {
    const projectRoot = engine.resolveProjectRoot();
    if (!projectRoot) {
      return { text: '❌ No active project found. Create one first with *create.' };
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
      case 'deploy':
        // These phases are simpler — let Claude handle them normally
        // (they don't have the 30-minute orchestration problem)
        return this._processMessageDirect(msg);
      default:
        response = `Unknown phase: ${phase}`;
    }

    // Save to chat history
    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', response.slice(0, 2000));
    this._updateGlobalFocus(msg, projectRoot);

    return { text: response };
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

          // Dev phase in progress: generate progress card directly
          if (focus.phase === 3 || focus.phase === '3') {
            const phase3Path = path.join(projectRoot, '.yuri', 'state', 'phase3.yaml');
            if (fs.existsSync(phase3Path)) {
              const phase3 = yaml.load(fs.readFileSync(phase3Path, 'utf8')) || {};
              if (phase3.status === 'in_progress') {
                // Temporarily set orchestrator's project root to generate card
                const savedRoot = this.orchestrator._projectRoot;
                const savedSession = this.orchestrator._session;
                const savedStarted = this.orchestrator._devStartedAt;

                this.orchestrator._projectRoot = projectRoot;
                if (phase3.tmux && phase3.tmux.session) {
                  this.orchestrator._session = phase3.tmux.session;
                }
                this.orchestrator._devStartedAt = phase3.started_at
                  ? new Date(phase3.started_at).getTime() : Date.now();

                try {
                  const progress = this.orchestrator._gatherDevProgress();
                  const card = this.orchestrator._buildProgressCard(progress);
                  parts.push(card);
                } catch { /* fallback below */ }

                // Restore
                this.orchestrator._projectRoot = savedRoot;
                this.orchestrator._session = savedSession;
                this.orchestrator._devStartedAt = savedStarted;
              }
            }
          }

          // Fallback: show pulse/step if no card was generated
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
      parts.push('No active phase. Available commands: *create, *plan, *develop, *test, *deploy, *projects, *switch');
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

    // If a phase is running, inject tmux pane context so Claude can see agent state
    let prompt = engine.composePrompt(msg.text);
    if (this.orchestrator.isRunning()) {
      const agentContext = this.orchestrator.captureCurrentAgentContext();
      if (agentContext) {
        prompt = `${agentContext}\n\n---\n\nUser message: ${msg.text}`;
      }
    }

    log.router(`Processing: "${msg.text.slice(0, 80)}..." → cwd: ${projectRoot || '~'}`);
    const result = await engine.callClaude({
      prompt,
      cwd: projectRoot,
      engineConfig: this.config.engine,
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
      return { text: 'No projects registered yet. Use *create to create one.' };
    }

    const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
    const projects = registry.projects || [];
    if (projects.length === 0) {
      return { text: 'No projects registered yet. Use *create to create one.' };
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
    this.orchestrator.shutdown();
    if (engine.destroySession) engine.destroySession();
  }
}

module.exports = { Router };
