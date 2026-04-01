'use strict';

const { execSync } = require('child_process');
const crypto = require('crypto');

/**
 * Shared tmux utilities for phase orchestration.
 * All operations are synchronous (execSync) since tmux commands are instant.
 */

function tmux(cmd) {
  return execSync(`tmux ${cmd}`, { encoding: 'utf8', timeout: 10000 }).trim();
}

function tmuxSafe(cmd) {
  try { return tmux(cmd); } catch { return null; }
}

function hasSession(session) {
  return tmuxSafe(`has-session -t "${session}" 2>/dev/null`) !== null;
}

function killSession(session) {
  tmuxSafe(`kill-session -t "${session}"`);
}

function capturePane(session, window, lines) {
  return tmuxSafe(`capture-pane -t "${session}:${window}" -p -S -${lines || 200}`) || '';
}

function sendKeys(session, window, text) {
  // Escape all shell metacharacters inside double quotes: " $ ` \ !
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/!/g, '\\!');
  tmux(`send-keys -t "${session}:${window}" "${escaped}"`);
}

/**
 * Send text to a tmux pane with proper Enter handling.
 * 3-step pattern: send content → sleep 1s → send Enter.
 */
function sendKeysWithEnter(session, window, text) {
  sendKeys(session, window, text);
  execSync('sleep 1');
  tmux(`send-keys -t "${session}:${window}" Enter`);
}

function newWindow(session, windowIdx, name, cwd) {
  tmux(`new-window -t "${session}:${windowIdx}" -n "${name}" -c "${cwd}"`);
}

/**
 * Wait for Claude Code's ❯ prompt to appear in pane.
 * Also auto-accepts "trust this folder" dialog if detected.
 *
 * @returns {boolean} true if prompt appeared, false if timeout
 */
function waitForPrompt(session, window, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 30000);
  const pollMs = 2000;

  while (Date.now() < deadline) {
    execSync(`sleep ${pollMs / 1000}`);
    const pane = capturePane(session, window, 15);

    // Auto-accept trust dialog
    if (/trust this folder|safety check/i.test(pane)) {
      tmux(`send-keys -t "${session}:${window}" Enter`);
      execSync('sleep 2');
      continue;
    }

    // ❯ prompt means Claude Code is ready
    if (/❯/.test(pane)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a Claude Code agent has finished in a tmux pane.
 * Mirrors the logic from monitor-agent.sh.
 *
 * @returns {'complete'|'idle'|'running'|'stable'}
 */
function checkCompletion(session, window, lastHash) {
  const pane = capturePane(session, window, 200);
  const tail = pane.split('\n').slice(-10).join('\n');

  // P1: Completion message ("Baked for 31s", "Worked for 2m")
  if (/[A-Z][a-z]*ed for \d+/.test(tail)) {
    return { status: 'complete', hash: null };
  }

  // P2: ❯ prompt with no active spinner — might be idle
  // (Less reliable than completion message but still useful)

  // P3: Content stability
  const hash = crypto.createHash('md5').update(pane).digest('hex');
  if (hash === lastHash) {
    return { status: 'stable', hash };
  }

  return { status: 'running', hash };
}

module.exports = {
  hasSession,
  killSession,
  capturePane,
  sendKeys,
  sendKeysWithEnter,
  newWindow,
  waitForPrompt,
  checkCompletion,
};
