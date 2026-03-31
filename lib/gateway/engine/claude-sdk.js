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

/**
 * Check if a YAML file is still an empty template (all leaf values are "", [], null).
 */
function isEmptyTemplate(yamlContent) {
  try {
    const parsed = yaml.load(yamlContent);
    if (!parsed || typeof parsed !== 'object') return true;
    return checkAllEmpty(parsed);
  } catch { return true; }
}

function checkAllEmpty(obj) {
  for (const val of Object.values(obj)) {
    if (val === null || val === undefined || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (typeof val === 'object' && !Array.isArray(val)) {
      if (!checkAllEmpty(val)) return false;
      continue;
    }
    return false; // non-empty leaf found
  }
  return true;
}

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
    if (!fs.existsSync(f.path)) continue;
    const content = fs.readFileSync(f.path, 'utf8').trim();
    // Skip empty template files — they waste tokens and confuse Claude with name: ""
    if (!content || isEmptyTemplate(content)) continue;
    sections.push(`### ${f.label}\n\`\`\`yaml\n${content}\n\`\`\``);
  }

  return sections.length > 0
    ? `## Yuri Global Memory (L1 — pre-loaded)\n\n${sections.join('\n\n')}`
    : '';
}

/**
 * Load L2 (project-level) context for the active project.
 * Only loads lightweight files: identity.yaml and project focus.yaml.
 * knowledge/*.md files are intentionally excluded (too large for system prompt —
 * Claude can Read them on demand via tool use).
 */
function loadL2Context() {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) return '';

  const yuriDir = path.join(projectRoot, '.yuri');
  if (!fs.existsSync(yuriDir)) return '';

  const files = [
    { label: 'Project Identity', path: path.join(yuriDir, 'identity.yaml') },
    { label: 'Project Focus', path: path.join(yuriDir, 'focus.yaml') },
  ];

  const sections = [];
  for (const f of files) {
    if (!fs.existsSync(f.path)) continue;
    const content = fs.readFileSync(f.path, 'utf8').trim();
    if (!content || isEmptyTemplate(content)) continue;
    sections.push(`### ${f.label}\n\`\`\`yaml\n${content}\n\`\`\``);
  }

  if (sections.length === 0) return '';

  // Also list available knowledge files (so Claude knows they exist)
  const knowledgeDir = path.join(yuriDir, 'knowledge');
  let knowledgeNote = '';
  if (fs.existsSync(knowledgeDir)) {
    try {
      const knowledgeFiles = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'));
      if (knowledgeFiles.length > 0) {
        knowledgeNote = `\n\n*Project knowledge files available (use Read tool to access):*\n` +
          knowledgeFiles.map((f) => `- \`${path.join(yuriDir, 'knowledge', f)}\``).join('\n');
      }
    } catch { /* ok */ }
  }

  return `## Active Project Context (L2)\n\n${sections.join('\n\n')}${knowledgeNote}`;
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
let _lastL1Hash = null;
let _totalCost = 0;
let _totalDuration = 0;

// ── System Prompt ──────────────────────────────────────────────────────────────

const SKILL_PATH = path.join(os.homedir(), '.claude', 'skills', 'yuri', 'SKILL.md');

const CHANNEL_MODE_INSTRUCTIONS = [
  '## Channel Mode (Yuri Gateway)',
  '',
  'You are responding via a messaging channel (Telegram/Feishu), not a terminal.',
  '- Keep responses concise and mobile-friendly.',
  '- Use markdown formatting sparingly (Telegram supports basic markdown).',
  '- If you need to perform operations, do so and report the result.',
  '- Memory signals (preferences, identity, priorities) are detected and',
  '  processed automatically by the gateway. You do not need to write to',
  '  inbox.jsonl or manage memory files manually.',
].join('\n');

/**
 * Build the system prompt that gives Claude the Yuri identity.
 *
 * Layers (in order):
 *   1. SKILL.md — Yuri persona, commands, activation protocol, behavior rules
 *   2. L1 context — global memory (self.yaml, boss profile, portfolio, focus)
 *   3. Channel mode — Telegram-specific response formatting rules
 *
 * In terminal mode, SKILL.md is loaded automatically by Claude Code's /yuri skill.
 * In gateway mode (-p), we must inject it manually via --system-prompt.
 */
function buildSystemPrompt() {
  const parts = [];

  // Layer 1: Yuri persona (extracted essentials from SKILL.md)
  // The full SKILL.md is ~11KB — too large for system prompt.
  // We extract only: persona, principles, commands, greeting templates.
  // Implementation details (tmux rules, memory layout, completion detection)
  // are in task files and loaded by Claude on demand.
  if (fs.existsSync(SKILL_PATH)) {
    let skill = fs.readFileSync(SKILL_PATH, 'utf8');
    skill = skill.replace(/^---[\s\S]*?---\s*\n/, ''); // strip frontmatter

    // Extract sections up to "## Phase Execution" (everything after is implementation detail)
    const cutoff = skill.indexOf('## Phase Execution');
    if (cutoff > 0) {
      skill = skill.slice(0, cutoff).trim();
    }

    parts.push(skill);
  } else {
    parts.push(
      '# Yuri — Meta-Orchestrator\n\n' +
      'You are **Yuri**, a Meta-Orchestrator and Technical Chief of Staff.\n' +
      'You manage the user\'s entire project portfolio via Orchestrix agents.\n' +
      'NEVER say you are Claude or Claude Code. You are Yuri.'
    );
  }

  // Layer 2: L1 global memory
  const l1 = loadL1Context();
  if (l1) parts.push(l1);

  // Layer 2.5: L2 project context (lightweight — identity + focus only)
  // knowledge/*.md is NOT loaded here (too large for system prompt).
  // Claude can Read those files when needed via tool use.
  const l2 = loadL2Context();
  if (l2) parts.push(l2);

  // Layer 3: Channel mode instructions
  parts.push(CHANNEL_MODE_INSTRUCTIONS);

  return parts.join('\n\n---\n\n');
}

// ── Session Persistence ────────────────────────────────────────────────────────

// Session format version — increment when system prompt changes significantly
// to force fresh session creation instead of resuming with stale identity.
const SESSION_VERSION = 2;

function saveSessionState() {
  try {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      version: SESSION_VERSION,
      sessionId: _sessionId,
      messageCount: _messageCount,
      totalCost: _totalCost,
      totalDuration: _totalDuration,
      savedAt: new Date().toISOString(),
    }));
  } catch { /* best effort */ }
}

function loadSessionState() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    // Reject: wrong version (system prompt changed), or expired (>24h)
    if (state.version !== SESSION_VERSION) return null;
    const age = Date.now() - new Date(state.savedAt).getTime();
    if (age > 24 * 3600_000) return null;
    return state;
  } catch { return null; }
}

function clearSessionState() {
  _sessionId = null;
  _messageCount = 0;
  try { fs.unlinkSync(SESSION_FILE); } catch { /* ok */ }
}

/**
 * Build a clean env for Claude CLI — remove third-party API overrides.
 * Users may have ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL set for other tools
 * (DeepSeek, Kimi, GLM, etc.) which would redirect Claude CLI to wrong API.
 */
function cleanEnv() {
  const env = { ...process.env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_MODEL;
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
  return env;
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
      env: cleanEnv(),
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        log.warn('Claude CLI timed out');
        return resolve({ reply: '⏱ Response timed out.', raw: '' });
      }
      // Claude CLI may return non-zero exit code even with valid JSON output
      // (e.g., stderr "Warning: no stdin data received" causes exit code 1).
      // Always try to parse stdout first before treating as error.
      if (err && !stdout.trim()) {
        log.error(`Claude CLI error: ${err.message.slice(0, 200)}`);
        if (stderr) log.info(`stderr: ${stderr.slice(0, 200)}`);
        return resolve({ reply: `❌ Claude CLI error: ${err.message.slice(0, 200)}`, raw: stderr });
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
          if (saved && saved.sessionId) {
            log.engine(`Restoring session ${saved.sessionId.slice(0, 8)}...`);
            _sessionId = saved.sessionId;
            _messageCount = saved.messageCount || 0;
            _totalCost = saved.totalCost || 0;
            _totalDuration = saved.totalDuration || 0;
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

        let systemPromptFile = null;
        if (_sessionId) {
          args.push('--resume', _sessionId);
        } else {
          // Write system prompt to temp file — too large for CLI argument
          systemPromptFile = path.join(os.tmpdir(), `yuri-sp-${Date.now()}.txt`);
          fs.writeFileSync(systemPromptFile, buildSystemPrompt());
          args.push('--system-prompt-file', systemPromptFile);
        }

        args.push(prompt);

        // Execute
        const result = await runClaude(args, cwd, callTimeout);

        // Cleanup system prompt temp file
        if (systemPromptFile) {
          try { fs.unlinkSync(systemPromptFile); } catch { /* ok */ }
        }

        // Store session ID for subsequent calls
        if (result.sessionId) {
          _sessionId = result.sessionId;
        }

        _messageCount++;
        if (result.cost) _totalCost += result.cost;
        if (result.duration) _totalDuration += result.duration;
        saveSessionState();

        // If --resume failed (session expired), retry with fresh session
        if (result.reply && result.reply.includes('❌') && _sessionId) {
          log.warn('Session may have expired, retrying with fresh session...');
          clearSessionState();

          const freshSpFile = path.join(os.tmpdir(), `yuri-sp-fresh-${Date.now()}.txt`);
          fs.writeFileSync(freshSpFile, buildSystemPrompt());
          const freshArgs = [
            '-p', '--output-format', 'json', '--dangerously-skip-permissions',
            '--system-prompt-file', freshSpFile,
            prompt,
          ];
          const freshResult = await runClaude(freshArgs, cwd, callTimeout);
          try { fs.unlinkSync(freshSpFile); } catch { /* ok */ }
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
 * Compose prompt for the user message.
 * If L1 context has changed since the last call (e.g., reflect engine updated
 * boss/preferences.yaml), prepend a context refresh block so the resumed
 * session gets the latest memory without needing a new system prompt.
 */
function composePrompt(userMessage) {
  const crypto = require('crypto');
  const l1 = loadL1Context();
  const l2 = loadL2Context();
  const combined = (l1 || '') + (l2 || '');
  const contextHash = crypto.createHash('md5').update(combined).digest('hex');

  // First call or context unchanged: just the user message
  if (!_lastL1Hash || contextHash === _lastL1Hash) {
    _lastL1Hash = contextHash;
    return userMessage;
  }

  // Context changed: prepend refresh
  _lastL1Hash = contextHash;
  if (!combined) return userMessage;

  const sections = [];
  if (l1) sections.push(l1);
  if (l2) sections.push(l2);

  log.engine('Memory context changed, injecting refresh into prompt');
  return `[CONTEXT UPDATE — Your memory has been updated]\n${sections.join('\n\n')}\n[END CONTEXT UPDATE]\n\n${userMessage}`;
}

/**
 * Destroy session state. Called on gateway shutdown.
 */
function destroySession() {
  log.engine('Gateway shutting down (session preserved for restart)');
}

/**
 * Get accumulated cost and usage stats.
 */
function getUsageStats() {
  return {
    messageCount: _messageCount,
    totalCost: _totalCost,
    totalDuration: _totalDuration,
  };
}

module.exports = {
  callClaude,
  composePrompt,
  loadL1Context,
  resolveProjectRoot,
  findClaudeBinary,
  destroySession,
  clearSessionState,
  getUsageStats,
  // Exported for testing
  isEmptyTemplate,
};
