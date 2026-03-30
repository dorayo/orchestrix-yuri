'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { ChatHistory } = require('./history');
const { OwnerBinding } = require('./binding');
const engine = require('./engine/claude-sdk');
const { runReflect } = require('./engine/reflect');
const { log } = require('./log');

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
      log.router(`First bind: ${msg.channelType} chat ${msg.chatId} (${msg.userName})`);
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
    // ═══ ENGINE: Reflect (code-enforced) ═══
    // Process any unprocessed inbox signals BEFORE the Claude call,
    // so the updated memory is available in the system prompt.
    try { runReflect(); } catch (err) { log.warn(`Reflect failed: ${err.message}`); }

    // ═══ ENGINE: Catch-up (code-enforced) ═══
    await this._runCatchUp();

    // ═══ Resolve project context ═══
    const projectRoot = engine.resolveProjectRoot();

    // ═══ Compose prompt ═══
    const prompt = engine.composePrompt(msg.text);

    // ═══ WORK: Call Claude engine ═══
    log.router(`Processing: "${msg.text.slice(0, 80)}..." → cwd: ${projectRoot || '~'}`);
    const result = await engine.callClaude({
      prompt,
      cwd: projectRoot,
      engineConfig: this.config.engine,
    });

    // ═══ Save chat history ═══
    this.history.append(msg.chatId, 'user', msg.text);
    this.history.append(msg.chatId, 'assistant', result.reply.slice(0, 2000));

    // ═══ ENGINE: Observe (code-enforced signal detection) ═══
    // Detect signals from BOTH user message and Claude's response.
    this._detectSignals(msg, result.reply);

    // ═══ ENGINE: Update Focus (code-enforced) ═══
    this._updateGlobalFocus(msg, projectRoot);

    log.router(`Reply: "${result.reply.slice(0, 80)}..."`);
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
      log.router(`Catch-up: ${Math.round(gap / 60000)}min since last active. Refreshing portfolio.`);
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

  // ── Signal Detection Patterns (word-boundary aware) ──

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

  /**
   * Detect signals from user message AND Claude's response.
   * Uses word-boundary regex to avoid false positives.
   */
  _detectSignals(msg, claudeReply) {
    const inboxPath = path.join(YURI_GLOBAL, 'inbox.jsonl');
    const signals = [];

    const text = msg.text;

    // Detect from user message
    if (Router.PRIORITY_PATTERNS.some((re) => re.test(text))) {
      signals.push({ signal: 'priority_change', raw: text });
    }
    if (Router.PREFERENCE_PATTERNS.some((re) => re.test(text))) {
      signals.push({ signal: 'boss_preference', raw: text });
    }
    if (Router.IDENTITY_PATTERNS.some((re) => re.test(text))) {
      signals.push({ signal: 'boss_identity', raw: text });
    }

    // Detect from Claude's response (confirms Claude recognized a signal)
    if (claudeReply) {
      if (Router.RESPONSE_PREFERENCE_HINTS.some((re) => re.test(claudeReply))) {
        // Only add if we didn't already detect from user message
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

    // Write to inbox
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
      log.warn(`Failed to update focus: ${err.message}`);
    }
  }

  /**
   * Graceful shutdown — destroy persistent engine session if active.
   */
  async shutdown() {
    if (engine.destroySession) {
      engine.destroySession();
    }
  }
}

module.exports = { Router };
