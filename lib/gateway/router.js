'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { ChatHistory } = require('./history');
const { OwnerBinding } = require('./binding');

/**
 * Select engine based on config.
 * 'persistent' uses tmux session; 'one-shot' uses claude -p per message.
 */
function loadEngine(engineType) {
  if (engineType === 'persistent') {
    return require('./engine/claude-tmux');
  }
  return require('./engine/claude-cli');
}


const YURI_GLOBAL = path.join(os.homedir(), '.yuri');

/**
 * Message router with five-engine orchestration.
 * Each engine is triggered by code logic, not prompt compliance.
 */
class Router {
  /**
   * @param {object} config - Parsed channels.yaml config
   */
  constructor(config) {
    this.config = config;
    this.engine = loadEngine(config.engine.type || 'one-shot');
    this.history = new ChatHistory({
      storageDir: config.chat_history.storage,
      maxMessages: config.chat_history.max_messages,
    });
    this.bindings = {
      telegram: new OwnerBinding({ channelType: 'telegram' }),
      feishu: new OwnerBinding({ channelType: 'feishu' }),
    };
    this.processing = new Set(); // prevent concurrent processing per chat
  }

  /**
   * Handle an incoming channel message. This is the main entry point.
   * All five engines are orchestrated here via code.
   *
   * @param {object} msg - {channelType, channelUserId, chatId, text, userName}
   * @returns {Promise<{text: string}>}
   */
  async handleMessage(msg) {
    // ═══ AUTH ═══
    const binding = this.bindings[msg.channelType];
    if (!binding) {
      return { text: '❌ Unsupported channel type.' };
    }

    const authResult = binding.check(msg.chatId);
    if (!authResult.allowed) {
      return { text: '🔒 Unauthorized. This bot is private.' };
    }

    if (authResult.firstBind) {
      console.log(`[router] First bind: ${msg.channelType} chat ${msg.chatId} (${msg.userName})`);
    }

    // Handle /start command
    if (msg.text === '/start') {
      if (authResult.firstBind) {
        return { text: `🚀 Welcome! You are now bound as the owner of this Yuri instance.\n\nSend me any message to interact with your projects.` };
      }
      return { text: `🚀 Yuri is ready. Send me any message to interact with your projects.` };
    }

    // Prevent concurrent processing for same chat
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

  async _processMessage(msg) {
    // ═══ ENGINE: Catch-up (code-enforced) ═══
    await this._runCatchUp();

    // ═══ ENGINE: Load L1 (code pre-loads into prompt) ═══
    // L1 is loaded inside composePrompt() — injected into the prompt automatically.
    // Claude does not need to "remember" to read these files.

    // ═══ Resolve project context ═══
    const projectRoot = this.engine.resolveProjectRoot();

    // ═══ Get chat history for conversation continuity ═══
    const chatHistory = this.history.getRecent(msg.chatId);

    // ═══ Compose prompt: L1 context + chat history + user message ═══
    const prompt = this.engine.composePrompt(msg.text, chatHistory);

    // ═══ WORK: Call Claude engine ═══
    console.log(`[router] Processing (${this.config.engine.type}): "${msg.text.slice(0, 80)}..." → cwd: ${projectRoot || '~'}`);
    const result = await this.engine.callClaude({
      prompt,
      cwd: projectRoot,
      engineConfig: this.config.engine,
    });

    // ═══ Save chat history ═══
    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', result.reply.slice(0, 2000));

    // ═══ ENGINE: Observe (code writes inbox) ═══
    // In channel mode, observations are extracted from Claude's response.
    // Claude is instructed to write to inbox.jsonl directly via the Channel Mode Instructions.
    // Additionally, we detect priority signals from the user's message here.
    this._detectBasicSignals(msg);

    // ═══ ENGINE: Update Focus (code-enforced) ═══
    this._updateGlobalFocus(msg, projectRoot);

    console.log(`[router] Reply: "${result.reply.slice(0, 80)}..."`);
    return { text: result.reply };
  }

  /**
   * ENGINE: Catch-up — check if Yuri has been idle and needs to refresh state.
   */
  async _runCatchUp() {
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    if (!fs.existsSync(focusPath)) return;

    const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
    if (!focus.updated_at) return;

    const gap = Date.now() - new Date(focus.updated_at).getTime();
    const ONE_HOUR = 3600_000;

    if (gap > ONE_HOUR) {
      console.log(`[router] Catch-up: ${Math.round(gap / 60000)}min since last active. Refreshing portfolio.`);
      this._refreshPortfolioPulse();
    }
  }

  /**
   * Refresh portfolio pulse by scanning active projects.
   */
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

  /**
   * Detect basic signals from the user's message (code-level observation).
   */
  _detectBasicSignals(msg) {
    const text = msg.text.toLowerCase();
    const inboxPath = path.join(YURI_GLOBAL, 'inbox.jsonl');

    const signals = [];

    // Priority change signals
    const priorityPatterns = ['先搞', '暂停', '不做了', 'urgent', 'deadline', 'focus on', 'pause', 'stop'];
    if (priorityPatterns.some((p) => text.includes(p))) {
      signals.push({ signal: 'priority_change', raw: msg.text });
    }

    // Preference signals
    const prefPatterns = ['别', '不要', 'don\'t', 'stop doing', 'from now on', '以后'];
    if (prefPatterns.some((p) => text.includes(p))) {
      signals.push({ signal: 'boss_preference', raw: msg.text });
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
  }

  /**
   * Update global focus after processing a message.
   */
  _updateGlobalFocus(msg, projectRoot) {
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    if (!fs.existsSync(focusPath)) return;

    try {
      const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
      focus.active_action = `channel:${msg.channelType} — last msg: "${msg.text.slice(0, 60)}"`;
      focus.updated_at = new Date().toISOString();
      fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
    } catch (err) {
      console.error('[router] Failed to update focus:', err.message);
    }
  }

  /**
   * Graceful shutdown — destroy persistent engine session if active.
   */
  async shutdown() {
    if (this.engine.destroySession) {
      this.engine.destroySession();
    }
  }
}

module.exports = { Router };
