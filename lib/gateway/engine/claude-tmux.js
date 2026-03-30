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
// Claude Code TUI state indicators vary by version and statusline config:
//
//   Idle indicators (any of these = ready for input):
//     ○  (U+25CB) — circle idle indicator (shown with certain statusline configs)
//     ❯           — prompt cursor (always shown when idle, most reliable)
//
//   Processing indicators:
//     ●  (U+25CF) — filled circle, active generation
//     Braille spinner: ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
//
//   Status line elements (NOT state indicators):
//     ◐  — effort level indicator (e.g. "◐ medium · /effort"), NOT approval prompt
//
//   Completion message (past-tense verb + duration):
//     "Baked for 31s", "Worked for 2m 45s"
//     Pattern: /[A-Z][a-z]*ed for \d+/
//
// ────────────────────────────────────────────────────────────────────────────────

const BRAILLE_SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const COMPLETION_RE = /[A-Z][a-z]*ed for \d+/;
const IDLE_RE = /[○❯]/;
const PROCESSING_RE = /●/;

/**
 * Strip TUI chrome from captured pane output.
 * `tmux capture-pane -p` (without -e) already strips most ANSI codes,
 * but we clean up residual artifacts and Claude Code UI elements.
 */
function stripChrome(raw) {
  return raw
    // ANSI escape sequences
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B\].*?\x07/g, '')
    // TUI indicators and decorations
    .replace(/[○●◐◑⏺]/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')
    .replace(/[⏵━─█·…→]/g, '')
    // Claude Code banner
    .replace(/^.*▐▛.*$/gm, '')
    .replace(/^.*▝▜.*$/gm, '')
    .replace(/^.*▘▘.*$/gm, '')
    .replace(/^.*Claude Code v[\d.]+.*$/gm, '')
    .replace(/^.*Opus.*context.*$/gm, '')
    // Status line elements
    .replace(/^.*bypass permissions.*$/gm, '')
    .replace(/^.*shift\+tab to cycle.*$/gm, '')
    .replace(/^.*◐\s*(min|medium|max|low|high).*$/gm, '')
    .replace(/^.*\/effort.*$/gm, '')
    .replace(/^.*Proxy\s*-\s*(On|Off).*$/gm, '')
    // Shell commands that leaked
    .replace(/^.*export\s+CLAUDE_AUTOCOMPACT.*$/gm, '')
    .replace(/^.*dangerously-skip-permissions.*$/gm, '')
    // Completion stats and spinner verbs
    .replace(/^.*[A-Z][a-z]*ed for \d+.*$/gm, '')
    .replace(/^.*[A-Z][a-z]*ing\.{3}.*$/gm, '')
    // Prompt cursor and line decorations
    .replace(/^❯\s*$/gm, '')
    .replace(/^─+$/gm, '')
    // Line-number gutter
    .replace(/^\s*\d+\s*[│|]\s*/gm, '')
    // Collapse blank lines
    .replace(/^\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
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
 * Check if Claude Code has started up and is ready for input.
 * Used ONLY during session initialization — looks for the ❯ input prompt
 * which appears once Claude Code has fully loaded.
 *
 * DO NOT use this for response completion detection — ❯ is always visible.
 */
function isStarted(name) {
  const tail = paneTail(name, 15);
  return IDLE_RE.test(tail);
}

/**
 * Check if a completion message is present in the pane output.
 * e.g. "Baked for 31s", "Worked for 2m 45s"
 * This is the most reliable signal that Claude has finished responding.
 */
function hasCompletionMessage(text) {
  return COMPLETION_RE.test(text);
}

/**
 * Check if Claude Code is actively processing (● spinner visible).
 */
function isProcessing(text) {
  return PROCESSING_RE.test(text) || BRAILLE_SPINNER.test(text);
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

  const ok = await waitForReady(name, 120000); // compact can take up to 2min
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
  log.tmux(`Binary: ${binary}`);
  log.tmux(`Project root: ${projectRoot}`);

  // Ensure CLAUDE.md has channel mode instructions (survives compact)
  ensureClaudeMd(projectRoot);

  // Only kill existing session if it exists — don't kill on retry
  // so the user can `tmux attach -t yuri-gateway` to debug
  if (hasSession(sessionName)) {
    log.tmux(`Killing existing session "${sessionName}"`);
    tmuxSafe(`kill-session -t ${sessionName}`);
  }

  // Create session with generous scrollback
  tmux(`new-session -d -s ${sessionName} -n claude -c "${projectRoot}"`);
  tmux(`set-option -t ${sessionName} history-limit ${HISTORY_LIMIT}`);
  log.tmux(`Session "${sessionName}" created, launching Claude Code...`);

  // Set env var and launch Claude Code in a single command to keep pane clean.
  // Using && chains avoids separate shell prompt lines polluting capture output.
  const compactPct = engineConfig.autocompact_pct || 80;
  tmux(`send-keys -t ${sessionName}:0 'export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${compactPct} && "${binary}" --dangerously-skip-permissions' Enter`);

  // Wait for Claude Code to initialize (detect ❯ prompt)
  const startupTimeout = engineConfig.startup_timeout || 60000;
  log.tmux(`Waiting for Claude Code to start (timeout: ${startupTimeout / 1000}s)...`);
  const started = await waitForReady(sessionName, startupTimeout);
  if (!started) {
    const tail = paneTail(sessionName, 10);
    log.error(`Claude Code did not start within ${startupTimeout / 1000}s`);
    log.error(`Last pane output:\n${tail}`);
    log.info(`Debug: tmux attach -t ${sessionName}`);
    throw new Error(`Claude Code did not start within ${startupTimeout / 1000}s`);
  }

  // Clear tmux scrollback so session setup commands don't pollute response capture.
  // The pane currently contains: shell commands, banner, status line.
  // We want captureResponse to only see content from user messages onward.
  await new Promise((r) => setTimeout(r, 1000)); // let TUI fully render
  tmuxSafe(`clear-history -t ${sessionName}:0`);

  // NOTE: We do NOT inject L1 context here. Instead, composePrompt() prepends
  // L1 to the first user message. This avoids: (1) scrollback pollution from
  // a huge YAML block, (2) waitForReady returning immediately because ❯ is
  // always visible, (3) race conditions between L1 processing and first message.

  _sessionReady = true;
  log.tmux(`Session "${sessionName}" ready (cwd: ${projectRoot})`);
}

/**
 * Wait for Claude Code to be ready (❯ prompt visible).
 * Used for session init and after /compact — NOT for response capture.
 *
 * @returns {Promise<boolean>} true if ready detected, false if timeout
 */
function waitForReady(name, timeoutMs) {
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

      if (isStarted(name)) {
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
 * Detection strategy (❯ prompt is always visible, so we CANNOT use idle detection):
 *   P1: Completion message — "[Verb]ed for [N]s/m" (e.g. "Baked for 31s")
 *       Most reliable signal. Appears exactly once when Claude finishes.
 *   P2: Content stability — pane output unchanged for N consecutive polls.
 *       Fallback for edge cases where completion message is missed.
 *
 * We also track whether content has changed since injection (via marker)
 * to avoid returning before Claude has even started responding.
 */
async function captureResponse(name, marker, engineConfig) {
  const timeout = engineConfig.timeout || 300000;
  const pollInterval = engineConfig.poll_interval || 2000;
  const stableThreshold = engineConfig.stable_count || 3;

  const deadline = Date.now() + timeout;
  let lastHash = '';
  let stableCount = 0;
  let contentChanged = false;

  // Capture baseline right after injection
  const baselineRaw = capturePaneRaw(name, 500);
  const baselineHash = crypto.createHash('md5').update(baselineRaw).digest('hex');
  lastHash = baselineHash;

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

      const raw = capturePaneRaw(name, 500);
      const hash = crypto.createHash('md5').update(raw).digest('hex');

      // Track if content has changed since injection
      if (hash !== baselineHash) {
        contentChanged = true;
      }

      // P1: Completion message — most reliable done signal
      // Only check after content has changed (Claude has started responding)
      if (contentChanged && hasCompletionMessage(paneTail(name, 15))) {
        return resolve(extractResponse(raw, marker));
      }

      // P2: Content stability — pane unchanged for N polls
      // Only trigger after content has changed from baseline
      if (hash === lastHash) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHash = hash;
      }

      if (contentChanged && stableCount >= stableThreshold) {
        log.tmux('Response detected via content stability');
        return resolve(extractResponse(raw, marker));
      }

      setTimeout(poll, pollInterval);
    };

    // Initial delay: give Claude time to start processing
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
    log.tmux(`Marker found at line ${markerIdx}/${lines.length}`);
    const afterMarker = lines.slice(markerIdx + 1).join('\n');
    responseText = stripChrome(afterMarker);
  } else {
    log.warn(`Marker not found in pane output, using last 50 lines as fallback`);
    const tail = lines.slice(-50).join('\n');
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
        if (attempt === maxRetries) {
          log.error('All init attempts failed. Check Claude Code installation and tmux.');
          log.info(`Debug: tmux attach -t ${engineConfig.tmux_session || DEFAULT_SESSION}`);
          throw err;
        }
        // Kill session before retry so createSession starts fresh
        const sn = engineConfig.tmux_session || DEFAULT_SESSION;
        if (hasSession(sn)) tmuxSafe(`kill-session -t ${sn}`);
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
 * First message includes L1 context to prime the session.
 * Subsequent messages send only the raw user text.
 *
 * @param {string} userMessage - The user's message text
 * @param {Array} _chatHistory - Unused (Claude keeps its own context)
 * @returns {string}
 */
function composePrompt(userMessage, _chatHistory) {
  // First message: prepend L1 context so Claude knows who it is
  if (_messageCount === 0) {
    const l1 = loadL1Context();
    if (l1) {
      return `${l1}\n\n---\n\nUser message: ${userMessage}`;
    }
  }
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
