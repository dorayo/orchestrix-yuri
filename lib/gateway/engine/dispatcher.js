'use strict';

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const tmx = require('./tmux-utils');
const { log } = require('../log');

const SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'yuri');
const SESSION_NAME = 'yuri-dispatcher';

/**
 * Dispatcher: a persistent Claude Code instance in a tmux session
 * that classifies incoming natural language messages into structured actions.
 *
 * Runs independently from the Yuri conversation session to avoid
 * polluting chat history with classification prompts.
 */
class Dispatcher {
  constructor(config) {
    this._config = config || {};
    this._ready = false;
    this._busy = false;
  }

  /**
   * Start the dispatcher tmux session with Claude Code + system prompt.
   * Called once on gateway startup. Reuses existing session if alive.
   */
  async start() {
    if (tmx.hasSession(SESSION_NAME)) {
      this._ready = true;
      log.engine('Dispatcher: reusing existing session');
      return;
    }

    try {
      execSync(`tmux new-session -d -s "${SESSION_NAME}" -x 200 -y 50`, { timeout: 10000 });
    } catch (err) {
      log.warn(`Dispatcher: failed to create tmux session: ${err.message}`);
      return;
    }

    // Launch Claude Code with dispatcher system prompt
    const promptPath = path.join(SKILL_DIR, 'resources', 'dispatcher-prompt.txt');
    tmx.sendKeysWithEnter(SESSION_NAME, 0,
      `claude --system-prompt-file "${promptPath}" --dangerously-skip-permissions`);

    // Wait for Claude Code to be ready (❯ prompt)
    const ready = tmx.waitForPrompt(SESSION_NAME, 0, 45000);
    this._ready = ready;

    if (ready) {
      log.engine('Dispatcher: ready');
    } else {
      log.warn('Dispatcher: Claude Code did not become ready within timeout');
    }
  }

  /**
   * Classify a user message into an action.
   * Returns { action, description, reasoning }.
   *
   * @param {string} text - raw user message
   * @returns {Promise<{action: string, description: string, reasoning: string}>}
   */
  async classify(text) {
    // Re-entry guard
    if (this._busy) {
      return { action: 'conversation', description: text, reasoning: 'dispatcher busy' };
    }

    // Auto-recover if session died
    if (!this._ready || !tmx.hasSession(SESSION_NAME)) {
      this._ready = false;
      await this.start();
      if (!this._ready) {
        return { action: 'conversation', description: text, reasoning: 'dispatcher unavailable' };
      }
    }

    this._busy = true;

    try {
      // Send user message to dispatcher
      tmx.sendKeysWithEnter(SESSION_NAME, 0, text);

      // Poll for completion (max 30s, every 2s)
      const deadline = Date.now() + 30000;
      let lastHash = '';
      let stableCount = 0;

      while (Date.now() < deadline) {
        execSync('sleep 2');
        const result = tmx.checkCompletion(SESSION_NAME, 0, lastHash);

        if (result.status === 'complete' || (result.status === 'stable' && ++stableCount >= 2)) {
          const output = tmx.capturePane(SESSION_NAME, 0, 30);
          return this._parseResponse(output, text);
        }

        if (result.status !== 'stable') {
          stableCount = 0;
          lastHash = result.hash || '';
        } else {
          lastHash = result.hash;
        }
      }

      // Timeout — default to change (bias toward action)
      log.warn('Dispatcher: classify timeout, defaulting to change');
      return { action: 'change', description: text, reasoning: 'classifier timeout' };
    } finally {
      this._busy = false;
    }
  }

  /**
   * Parse the dispatcher's tmux pane output to extract the JSON response.
   * Handles: bare JSON lines, markdown code blocks, partial lines with JSON.
   */
  _parseResponse(output, originalText) {
    const valid = ['bugfix', 'change', 'plan', 'develop', 'test', 'deploy', 'status', 'iterate', 'conversation'];

    // Strategy 1: Find JSON on its own line (bottom-up)
    const lines = output.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.includes('"action"')) {
        // Extract JSON substring (may be embedded in other text)
        const jsonMatch = line.match(/\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.action && valid.includes(parsed.action)) {
              return {
                action: parsed.action,
                description: parsed.description || originalText,
                reasoning: parsed.reasoning || '',
              };
            }
          } catch { /* continue */ }
        }
      }
    }

    // Strategy 2: Search entire output for JSON pattern (handles multiline/code blocks)
    const fullMatch = output.match(/\{\s*"action"\s*:\s*"(\w+)"[^}]*\}/);
    if (fullMatch) {
      try {
        const parsed = JSON.parse(fullMatch[0]);
        if (parsed.action && valid.includes(parsed.action)) {
          return {
            action: parsed.action,
            description: parsed.description || originalText,
            reasoning: parsed.reasoning || '',
          };
        }
      } catch { /* continue */ }

      // Even if full JSON parse fails, extract action from regex
      const action = fullMatch[1];
      if (valid.includes(action)) {
        return { action, description: originalText, reasoning: 'partial parse' };
      }
    }

    // Strategy 3: Look for bare action words in the last few lines
    const tail = lines.slice(-5).join(' ').toLowerCase();
    for (const action of valid) {
      if (action !== 'conversation' && tail.includes(`"${action}"`)) {
        return { action, description: originalText, reasoning: 'keyword match' };
      }
    }

    // Parse failed — default to "change" (bias toward action, not conversation)
    log.warn('Dispatcher: failed to parse response, defaulting to change');
    return { action: 'change', description: originalText, reasoning: 'parse failed' };
  }

  /**
   * Check if dispatcher is available.
   */
  isReady() {
    return this._ready && tmx.hasSession(SESSION_NAME);
  }

  /**
   * Gracefully shutdown the dispatcher session.
   */
  shutdown() {
    if (tmx.hasSession(SESSION_NAME)) {
      tmx.killSession(SESSION_NAME);
    }
    this._ready = false;
    this._busy = false;
    log.engine('Dispatcher: shutdown');
  }
}

module.exports = { Dispatcher };
