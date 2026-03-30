'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const yaml = require('js-yaml');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');
const { log } = require('../log');

// ── Shared Utilities (formerly in claude-cli.js) ───────────────────────────────

/**
 * Load L1 (global context) files and compose them into a context block.
 * Injected into the prompt so Claude does not need to "remember" to read them.
 */
function loadL1Context() {
  const files = [
    { label: 'Yuri Identity', path: path.join(YURI_GLOBAL, 'self.yaml') },
    { label: 'Boss Profile', path: path.join(YURI_GLOBAL, 'boss', 'profile.yaml') },
    { label: 'Boss Preferences', path: path.join(YURI_GLOBAL, 'boss', 'preferences.yaml') },
    { label: 'Portfolio Registry', path: path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml') },
    { label: 'Global Focus', path: path.join(YURI_GLOBAL, 'focus.yaml') },
  ];

  const sections = [];
  for (const f of files) {
    if (fs.existsSync(f.path)) {
      const content = fs.readFileSync(f.path, 'utf8').trim();
      if (content) {
        sections.push(`### ${f.label}\n\`\`\`yaml\n${content}\n\`\`\``);
      }
    }
  }

  return sections.length > 0
    ? `## Yuri Global Memory (L1 — pre-loaded)\n\n${sections.join('\n\n')}`
    : '';
}

/**
 * Determine which project the message likely relates to, based on portfolio.
 */
function resolveProjectRoot() {
  const registryPath = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
  if (!fs.existsSync(registryPath)) return null;

  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
  const projects = registry.projects || [];
  const active = projects.filter((p) => p.status === 'active');

  if (active.length === 0) return null;

  // Check global focus for active project
  const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
  if (fs.existsSync(focusPath)) {
    const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
    if (focus.active_project) {
      const match = active.find((p) => p.id === focus.active_project);
      if (match && fs.existsSync(match.root)) return match.root;
    }
  }

  // Fallback: first active project
  if (active[0] && fs.existsSync(active[0].root)) return active[0].root;

  return null;
}

/**
 * Find the claude binary path.
 * Shell aliases (like `cc`) are not available in child_process, so we
 * resolve the actual binary via the user's login shell PATH.
 */
function findClaudeBinary() {
  // Primary: resolve via user's login shell (handles all install methods)
  try {
    const resolved = execSync('zsh -lc "which claude" 2>/dev/null', { encoding: 'utf8' }).trim();
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // fall through
  }

  // Fallback: check common install locations
  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'bin', 'claude'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Last resort: let the shell find it
  return 'claude';
}

// Cache the binary path
let _claudeBinary = null;
function getClaudeBinary() {
  if (!_claudeBinary) {
    _claudeBinary = findClaudeBinary();
    log.tmux(`Using binary: ${_claudeBinary}`);
  }
  return _claudeBinary;
}

// ── Session Configuration ──────────────────────────────────────────────────────

const DEFAULT_SESSION = 'yuri-gateway';
const HISTORY_LIMIT = 10000;

// ── Singleton State ────────────────────────────────────────────────────────────

let _sessionName = null;
let _sessionReady = false;
let _initPromise = null;
let _messageQueue = Promise.resolve();
let _messageCount = 0;       // messages since last compact/session start

// ── Utilities ──────────────────────────────────────────────────────────────────

function tmux(cmd) {
  return execSync(`tmux ${cmd}`, { encoding: 'utf8', timeout: 10000 }).trim();
}

function tmuxSafe(cmd) {
  try {
    return tmux(cmd);
  } catch {
    return null;
  }
}

// ── Claude Code TUI Indicators ─────────────────────────────────────────────────
//
// Claude Code uses three circle symbols as primary state indicators:
//
//   ○  (U+25CB) IDLE       — Claude is waiting for user input
//   ●  (U+25CF) PROCESSING — Claude is actively generating a response
//   ◐  (U+25D0) APPROVAL   — Claude is waiting for permission approval
//
// During processing, a Braille spinner animates: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
// with cycling verbs like "Baking...", "Computing...", "Thinking..."
//
// Completion message format (past-tense verb + duration):
//   "Baked for 31s", "Worked for 2m 45s", "Cooked for 1m 6s"
//   Pattern: /[A-Z][a-z]*ed for \d+/
//
// ────────────────────────────────────────────────────────────────────────────────

const BRAILLE_SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const COMPLETION_RE = /[A-Z][a-z]*ed for \d+/;
const IDLE_RE = /○/;
const PROCESSING_RE = /●/;
const APPROVAL_RE = /◐/;

/**
 * Strip TUI chrome from captured pane output.
 * `tmux capture-pane -p` (without -e) already strips most ANSI codes,
 * but we clean up residual artifacts and Claude Code UI elements.
 */
function stripChrome(raw) {
  return raw
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')        // ANSI CSI escapes
    .replace(/\x1B\].*?\x07/g, '')                 // OSC sequences
    .replace(/[○●◐◑]/g, '')                        // TUI state indicators
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')                // Braille spinner frames
    .replace(/[⏵━─█·…→❯]/g, '')                    // UI decoration chars
    .replace(/^\s*\d+\s*[│|]\s*/gm, '')            // line-number gutter
    .replace(/^.*[A-Z][a-z]*ed for \d+.*$/gm, '')  // completion stats (all verbs)
    .replace(/^.*[A-Z][a-z]*ing\.{3}.*$/gm, '')    // spinner verb lines ("Baking...")
    .replace(/^\s*$/gm, '')                         // blank lines
    .trim();
}

// ── Session Lifecycle ──────────────────────────────────────────────────────────

function hasSession(name) {
  return tmuxSafe(`has-session -t ${name} 2>/dev/null`) !== null;
}

function capturePaneRaw(name, lines) {
  return tmuxSafe(`capture-pane -t ${name}:0 -p -S -${lines || 500}`) || '';
}

/**
 * Get the last N lines of the pane output for state detection.
 */
function paneTail(name, n) {
  return capturePaneRaw(name, n || 10);
}

/**
 * Detect Claude Code's current state from pane output.
 *
 * @returns {'idle'|'processing'|'approval'|'complete'|'unknown'}
 */
function detectState(name) {
  const tail = paneTail(name, 15);

  // Priority 1: Completion message — most reliable signal
  // e.g. "Baked for 31s", "Worked for 2m 45s"
  if (COMPLETION_RE.test(tail)) {
    return 'complete';
  }

  // Priority 2: Approval prompt — needs immediate response
  if (APPROVAL_RE.test(tail)) {
    return 'approval';
  }

  // Priority 3: Idle indicator — waiting for input
  if (IDLE_RE.test(tail)) {
    return 'idle';
  }

  // Priority 4: Processing indicator — still working
  if (PROCESSING_RE.test(tail) || BRAILLE_SPINNER.test(tail)) {
    return 'processing';
  }

  return 'unknown';
}

/**
 * Detect if Claude Code is idle (ready for input).
 * Checks for ○ idle indicator or completion message.
 */
function isIdle(name) {
  const state = detectState(name);
  return state === 'idle' || state === 'complete';
}

/**
 * Detect if Claude Code is showing an approval prompt (◐).
 */
function isApprovalPrompt(name) {
  return detectState(name) === 'approval';
}

/**
 * Detect if Claude Code is actively processing (● or spinner).
 */
function isProcessing(name) {
  return detectState(name) === 'processing';
}

// ── Context Management ─────────────────────────────────────────────────────────
//
// Claude Code has built-in auto-compact that triggers at ~95% context capacity.
// We improve on this with a 3-layer strategy:
//
//   Layer 1: CLAUDE.md persistence
//     Channel Mode Instructions are written to the project's CLAUDE.md.
//     CLAUDE.md survives compaction — it's re-read from disk after compact.
//     This means our core instructions are never lost.
//
//   Layer 2: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80
//     Set at session launch to trigger auto-compact at 80% instead of 95%.
//     This gives a comfortable buffer before context pressure causes issues.
//
//   Layer 3: Proactive /compact
//     After every N messages (configurable, default 50), we proactively
//     send /compact to keep the context lean. This prevents gradual
//     degradation in response quality from context bloat.
//
// Session rebuild is only used as a last resort when the session crashes.
// ────────────────────────────────────────────────────────────────────────────────

const CHANNEL_MODE_INSTRUCTIONS = [
  '## Channel Mode (Yuri Gateway)',
  '',
  'You are responding via a messaging channel (Telegram/Feishu), not a terminal.',
  '- Keep responses concise and mobile-friendly.',
  '- Use markdown formatting sparingly (Telegram supports basic markdown).',
  '- If you need to perform operations, do so and report the result.',
  '- At the end of your response, if you observed any memory-worthy signals',
  '  (user preferences, priority changes, tech lessons, corrections),',
  '  write them to ~/.yuri/inbox.jsonl.',
  '- Update ~/.yuri/focus.yaml and the project\'s focus.yaml after any operation.',
].join('\n');

/**
 * Ensure Channel Mode Instructions exist in the project's CLAUDE.md.
 * This guarantees instructions survive auto-compact (CLAUDE.md is re-read from disk).
 */
function ensureClaudeMd(projectRoot) {
  if (!projectRoot) return;

  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  const marker = '## Channel Mode (Yuri Gateway)';

  let content = '';
  if (fs.existsSync(claudeMdPath)) {
    content = fs.readFileSync(claudeMdPath, 'utf8');
    if (content.includes(marker)) return; // already present
  }

  // Append channel mode instructions
  const separator = content.trim() ? '\n\n' : '';
  fs.writeFileSync(claudeMdPath, content + separator + CHANNEL_MODE_INSTRUCTIONS + '\n');
  log.tmux(`Channel Mode Instructions written to ${claudeMdPath}`);
}

/**
 * Send /compact to Claude Code to proactively free context space.
 * Returns true if compact completed successfully.
 */
async function proactiveCompact(name) {
  log.tmux('Proactive /compact triggered');
  injectMessage(name, '/compact focus on the most recent user conversation and any pending operations');

  const ok = await waitForIdle(name, 120000); // compact can take up to 2min
  if (ok) {
    _messageCount = 0;
    log.tmux('Proactive /compact completed');
  } else {
    log.warn('Proactive /compact timed out');
  }
  return ok;
}

/**
 * Create a new tmux session and start Claude Code inside it.
 */
async function createSession(engineConfig) {
  const sessionName = engineConfig.tmux_session || DEFAULT_SESSION;
  _sessionName = sessionName;
  _sessionReady = false;
  _messageCount = 0;

  const binary = getClaudeBinary();
  const projectRoot = resolveProjectRoot() || os.homedir();

  // Ensure CLAUDE.md has channel mode instructions (survives compact)
  ensureClaudeMd(projectRoot);

  // Kill existing stale session
  if (hasSession(sessionName)) {
    tmuxSafe(`kill-session -t ${sessionName}`);
  }

  // Create session with generous scrollback
  tmux(`new-session -d -s ${sessionName} -n claude -c "${projectRoot}"`);
  tmux(`set-option -t ${sessionName} history-limit ${HISTORY_LIMIT}`);

  // Set auto-compact threshold to 80% (default is 95%)
  // This gives comfortable buffer before context pressure
  const compactPct = engineConfig.autocompact_pct || 80;
  tmux(`send-keys -t ${sessionName}:0 'export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${compactPct}' Enter`);

  // Launch Claude Code in interactive mode
  tmux(`send-keys -t ${sessionName}:0 '"${binary}" --dangerously-skip-permissions' Enter`);

  // Wait for Claude Code to initialize (detect idle indicator)
  const startupTimeout = engineConfig.startup_timeout || 30000;
  const started = await waitForIdle(sessionName, startupTimeout);
  if (!started) {
    throw new Error(`Claude Code did not become idle within ${startupTimeout}ms`);
  }

  // Send L1 context as the initial system message.
  // Channel Mode Instructions are already in CLAUDE.md (survives compact),
  // so we only inject L1 global memory here to prime the session.
  const l1 = loadL1Context();
  if (l1) {
    await injectMessage(sessionName, l1);
    await waitForIdle(sessionName, 120000); // allow up to 2min for L1 processing
  }

  _sessionReady = true;
  log.tmux(`Session "${sessionName}" ready (cwd: ${projectRoot})`);
}

/**
 * Wait for Claude Code to become idle.
 * @returns {Promise<boolean>} true if idle detected, false if timeout
 */
function waitForIdle(name, timeoutMs) {
  const pollInterval = 2000;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (Date.now() > deadline) {
        return resolve(false);
      }
      if (!hasSession(name)) {
        return resolve(false);
      }

      // Auto-approve any permission prompts
      if (isApprovalPrompt(name)) {
        tmuxSafe(`send-keys -t ${name}:0 'y' Enter`);
      }

      if (isIdle(name)) {
        return resolve(true);
      }
      setTimeout(poll, pollInterval);
    };
    setTimeout(poll, pollInterval); // initial delay
  });
}

/**
 * Inject a message into the tmux pane via load-buffer (avoids shell escaping issues).
 */
function injectMessage(name, text) {
  const tmpFile = path.join(os.tmpdir(), `yuri-tmux-msg-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, text);

  try {
    tmux(`load-buffer -b yuri-input "${tmpFile}"`);
    tmux(`paste-buffer -b yuri-input -t ${name}:0`);
    tmux(`send-keys -t ${name}:0 Enter`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/**
 * Capture the response after injecting a message.
 *
 * Detection priority (mirrors monitor-agent.sh):
 *   P1: Completion message — "[Verb]ed for [N]s/m" (e.g. "Baked for 31s")
 *   P2: Idle indicator — ○ appears in pane tail
 *   P3: Approval prompt — ◐ detected, auto-approve with 'y'
 *   P4: Content stability — 3 consecutive polls with identical MD5 hash
 */
async function captureResponse(name, marker, engineConfig) {
  const timeout = engineConfig.timeout || 300000;
  const pollInterval = engineConfig.poll_interval || 2000;
  const stableThreshold = engineConfig.stable_count || 3;

  const deadline = Date.now() + timeout;
  let lastHash = '';
  let stableCount = 0;
  let sawProcessing = false;

  return new Promise((resolve) => {
    const poll = () => {
      // Timeout: return whatever we have
      if (Date.now() > deadline) {
        log.warn('Response capture timed out');
        const raw = capturePaneRaw(name, 500);
        return resolve(extractResponse(raw, marker));
      }

      // Session died
      if (!hasSession(name)) {
        return resolve({ reply: '❌ Claude Code session terminated unexpectedly.', raw: '' });
      }

      const state = detectState(name);
      const raw = capturePaneRaw(name, 500);
      const hash = crypto.createHash('md5').update(raw).digest('hex');

      // Track that Claude has started processing (● appeared)
      // This prevents premature completion detection if ○ is still visible
      // from the previous idle state before Claude begins processing.
      if (state === 'processing') {
        sawProcessing = true;
        stableCount = 0;
        lastHash = hash;
        return setTimeout(poll, pollInterval);
      }

      // P3: Auto-approve permission prompts (◐)
      if (state === 'approval') {
        tmuxSafe(`send-keys -t ${name}:0 'y' Enter`);
        sawProcessing = true; // approval implies processing started
        stableCount = 0;
        lastHash = hash;
        // Brief pause after approval before next poll
        return setTimeout(poll, 2000);
      }

      // P1: Completion message — most reliable done signal
      if (state === 'complete' && sawProcessing) {
        return resolve(extractResponse(raw, marker));
      }

      // P2: Idle indicator — done if we saw processing start
      if (state === 'idle' && sawProcessing) {
        return resolve(extractResponse(raw, marker));
      }

      // P4: Content stability fallback
      if (hash === lastHash) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHash = hash;
      }

      if (stableCount >= stableThreshold && sawProcessing) {
        log.tmux('Response detected via content stability');
        return resolve(extractResponse(raw, marker));
      }

      setTimeout(poll, pollInterval);
    };

    // Initial delay: give Claude time to start processing
    // before first poll (avoids false-positive idle detection)
    setTimeout(poll, Math.max(pollInterval, 3000));
  });
}

/**
 * Extract the assistant's response from captured pane output.
 * Finds the marker, takes everything after it, strips chrome.
 */
function extractResponse(raw, marker) {
  const lines = raw.split('\n');
  let markerIdx = -1;

  // Find the last occurrence of the marker (in case of scrollback)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) {
      markerIdx = i;
      break;
    }
  }

  let responseText;
  if (markerIdx >= 0) {
    // Skip the marker line and any immediate echo of the user message
    const afterMarker = lines.slice(markerIdx + 1).join('\n');
    responseText = stripChrome(afterMarker);
  } else {
    // Fallback: take last chunk of output, strip chrome
    const tail = lines.slice(-100).join('\n');
    responseText = stripChrome(tail);
  }

  // Trim trailing idle indicators and empty lines
  responseText = responseText
    .replace(/[○●◐◑]\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { reply: responseText || '(no response captured)', raw };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Ensure the tmux session is alive and ready.
 * Lazy-initializes on first call. Restarts if session died.
 */
async function ensureSession(engineConfig) {
  if (_sessionName && hasSession(_sessionName) && _sessionReady) {
    return;
  }

  // Prevent concurrent initialization
  if (_initPromise) {
    return _initPromise;
  }

  const maxRetries = engineConfig.max_retries || 3;
  _initPromise = (async () => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await createSession(engineConfig);
        return;
      } catch (err) {
        log.warn(`Session init attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt === maxRetries) throw err;
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  try {
    await _initPromise;
  } finally {
    _initPromise = null;
  }
}

/**
 * Send a message to Claude Code via the persistent tmux session.
 *
 * @param {object} opts
 * @param {string} opts.prompt - User message to send
 * @param {string} opts.cwd - Working directory (used for session init, not per-message)
 * @param {object} opts.engineConfig - Engine configuration
 * @param {number} [opts.timeout=300000] - Timeout in ms
 * @returns {Promise<{reply: string, raw: string}>}
 */
async function callClaude(opts) {
  const { prompt, engineConfig, timeout } = opts;
  const config = { ...engineConfig, timeout: timeout || engineConfig.timeout || 300000 };

  // Queue messages to prevent concurrent injection into the same pane
  return new Promise((resolve, reject) => {
    _messageQueue = _messageQueue.then(async () => {
      try {
        await ensureSession(config);

        // Layer 3: Proactive compact after N messages
        const compactEvery = config.compact_every || 50;
        if (_messageCount >= compactEvery) {
          await proactiveCompact(_sessionName);
        }

        // Generate a unique marker for boundary detection
        const marker = `YURI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const markedPrompt = `[${marker}] ${prompt}`;

        // Inject and capture
        injectMessage(_sessionName, markedPrompt);
        const result = await captureResponse(_sessionName, marker, config);

        _messageCount++;
        resolve(result);
      } catch (err) {
        log.error(`callClaude error: ${err.message}`);

        // Mark session as not ready so it gets recreated next time
        _sessionReady = false;
        resolve({ reply: `❌ tmux engine error: ${err.message}`, raw: '' });
      }
    }).catch(reject);
  });
}

/**
 * Compose prompt for the persistent session.
 * Only sends the raw user message — the session already has L1 context
 * from initialization, and Claude Code maintains its own conversation history.
 *
 * @param {string} userMessage - The user's message text
 * @param {Array} _chatHistory - Unused (Claude keeps its own context)
 * @returns {string}
 */
function composePrompt(userMessage, _chatHistory) {
  return userMessage;
}

/**
 * Destroy the tmux session. Called on gateway shutdown.
 */
function destroySession() {
  if (_sessionName && hasSession(_sessionName)) {
    tmuxSafe(`kill-session -t ${_sessionName}`);
    log.tmux(`Session "${_sessionName}" destroyed.`);
  }
  _sessionName = null;
  _sessionReady = false;
  _initPromise = null;
}

module.exports = {
  callClaude,
  composePrompt,
  loadL1Context,
  resolveProjectRoot,
  findClaudeBinary,
  ensureSession,
  destroySession,
};
