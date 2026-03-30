'use strict';

const { execFile, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');
const SESSION_FILE = path.join(YURI_GLOBAL, 'gateway-session.json');
const { log } = require('../log');

// ── Shared Utilities ───────────────────────────────────────────────────────────

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

function resolveProjectRoot() {
  const registryPath = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
  if (!fs.existsSync(registryPath)) return null;

  const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
  const projects = registry.projects || [];
  const active = projects.filter((p) => p.status === 'active');

  if (active.length === 0) return null;

  const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
  if (fs.existsSync(focusPath)) {
    const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
    if (focus.active_project) {
      const match = active.find((p) => p.id === focus.active_project);
      if (match && fs.existsSync(match.root)) return match.root;
    }
  }

  if (active[0] && fs.existsSync(active[0].root)) return active[0].root;
  return null;
}

function findClaudeBinary() {
  try {
    const resolved = execSync('zsh -lc "which claude" 2>/dev/null', { encoding: 'utf8' }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch { /* fall through */ }

  const candidates = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'bin', 'claude'),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}

let _claudeBinary = null;
function getClaudeBinary() {
  if (!_claudeBinary) {
    _claudeBinary = findClaudeBinary();
    log.engine(`Using binary: ${_claudeBinary}`);
  }
  return _claudeBinary;
}

// ── State ──────────────────────────────────────────────────────────────────────

let _sessionId = null;
let _messageCount = 0;
let _messageQueue = Promise.resolve();

// ── System Prompt ──────────────────────────────────────────────────────────────

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

function buildSystemPrompt() {
  const l1 = loadL1Context();
  const parts = [];
  if (l1) parts.push(l1);
  parts.push(CHANNEL_MODE_INSTRUCTIONS);
  return parts.join('\n\n---\n\n');
}

// ── Session Persistence ────────────────────────────────────────────────────────

function saveSessionState() {
  try {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      sessionId: _sessionId,
      messageCount: _messageCount,
      savedAt: new Date().toISOString(),
    }));
  } catch { /* best effort */ }
}

function loadSessionState() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const age = Date.now() - new Date(state.savedAt).getTime();
    if (age > 24 * 3600_000) return null; // expire after 24h
    return state;
  } catch { return null; }
}

function clearSessionState() {
  _sessionId = null;
  _messageCount = 0;
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ok */ }
}

// ── Core: Run Claude CLI ───────────────────────────────────────────────────────

/**
 * Execute `claude -p --output-format json` and return parsed result.
 */
function runClaude(args, cwd, timeout) {
  return new Promise((resolve) => {
    const binary = getClaudeBinary();

    log.engine(`Calling: claude ${args.slice(0, 4).join(' ')}... (cwd: ${cwd})`);

    const proc = execFile(binary, args, {
      cwd,
      timeout: timeout || 300000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80',
      },
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        log.warn('Claude CLI timed out');
        return resolve({ reply: '⏱ Response timed out.', raw: '' });
      }
      if (err) {
        log.error(`Claude CLI error: ${err.message}`);
        if (stderr) log.info(`stderr: ${stderr.slice(0, 200)}`);
        return resolve({ reply: `❌ Claude CLI error: ${err.message}`, raw: stderr });
      }

      try {
        const result = JSON.parse(stdout);
        if (result.is_error) {
          return resolve({ reply: `❌ ${result.result || 'Unknown error'}`, raw: stdout });
        }

        const duration = result.duration_ms ? `${(result.duration_ms / 1000).toFixed(1)}s` : '?';
        const cost = result.total_cost_usd ? `$${result.total_cost_usd.toFixed(4)}` : '';
        log.engine(`Done in ${duration} ${cost}`);

        resolve({
          reply: result.result || '(empty response)',
          raw: stdout,
          sessionId: result.session_id,
          cost: result.total_cost_usd,
          duration: result.duration_ms,
        });
      } catch (parseErr) {
        // Non-JSON output — return raw
        log.warn(`Failed to parse JSON response: ${parseErr.message}`);
        resolve({ reply: stdout.trim() || '(empty response)', raw: stdout });
      }
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Send a message to Claude Code via `claude -p --output-format json`.
 * First call creates a session with --system-prompt.
 * Subsequent calls use --resume SESSION_ID for context continuity.
 */
async function callClaude(opts) {
  const { prompt, engineConfig, timeout } = opts;
  const cwd = resolveProjectRoot() || os.homedir();
  const callTimeout = timeout || engineConfig.timeout || 300000;

  return new Promise((resolve, reject) => {
    _messageQueue = _messageQueue.then(async () => {
      try {
        // Try to restore session from disk on first call
        if (!_sessionId) {
          const saved = loadSessionState();
          if (saved) {
            log.engine(`Restoring session ${saved.sessionId.slice(0, 8)}...`);
            _sessionId = saved.sessionId;
            _messageCount = saved.messageCount || 0;
          }
        }

        // Proactive compact
        const compactEvery = (engineConfig && engineConfig.compact_every) || 50;
        if (_messageCount > 0 && _messageCount % compactEvery === 0 && _sessionId) {
          log.engine('Proactive /compact...');
          await runClaude([
            '-p', '--output-format', 'json',
            '--dangerously-skip-permissions',
            '--resume', _sessionId,
            '/compact focus on the most recent user conversation',
          ], cwd, 120000);
          log.engine('/compact done');
        }

        // Build args
        const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions'];

        if (_sessionId) {
          args.push('--resume', _sessionId);
        } else {
          args.push('--system-prompt', buildSystemPrompt());
        }

        args.push(prompt);

        // Execute
        const result = await runClaude(args, cwd, callTimeout);

        // Store session ID for subsequent calls
        if (result.sessionId) {
          _sessionId = result.sessionId;
        }

        _messageCount++;
        saveSessionState();

        // If --resume failed (session expired), retry with fresh session
        if (result.reply && result.reply.includes('❌') && _sessionId) {
          log.warn('Session may have expired, retrying with fresh session...');
          clearSessionState();

          const freshArgs = [
            '-p', '--output-format', 'json', '--dangerously-skip-permissions',
            '--system-prompt', buildSystemPrompt(),
            prompt,
          ];
          const freshResult = await runClaude(freshArgs, cwd, callTimeout);
          if (freshResult.sessionId) {
            _sessionId = freshResult.sessionId;
            _messageCount = 1;
            saveSessionState();
          }
          return resolve(freshResult);
        }

        resolve(result);
      } catch (err) {
        log.error(`callClaude error: ${err.message}`);
        resolve({ reply: `❌ Engine error: ${err.message}`, raw: '' });
      }
    }).catch(reject);
  });
}

/**
 * Compose prompt — just returns the raw user message.
 * L1 context and channel instructions are handled by --system-prompt.
 */
function composePrompt(userMessage, _chatHistory) {
  return userMessage;
}

/**
 * Destroy session state. Called on gateway shutdown.
 */
function destroySession() {
  // Don't clear session file — allow restart to resume
  log.engine('Gateway shutting down (session preserved for restart)');
}

module.exports = {
  callClaude,
  composePrompt,
  loadL1Context,
  resolveProjectRoot,
  findClaudeBinary,
  destroySession,
};
