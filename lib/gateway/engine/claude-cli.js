'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');

/**
 * Load L1 (global context) files and compose them into a context block.
 * This is injected into the prompt so Claude does not need to "remember" to read them.
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
    const resolved = require('child_process')
      .execSync('zsh -lc "which claude" 2>/dev/null', { encoding: 'utf8' })
      .trim();
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
    console.log(`[claude-cli] Using binary: ${_claudeBinary}`);
  }
  return _claudeBinary;
}

/**
 * Execute a Claude CLI call with the Yuri skill.
 *
 * Uses `claude --dangerously-skip-permissions -p "prompt"` to match the user's
 * `cc` alias behavior. The prompt is written to a temp file to avoid command-line
 * length limits and shell escaping issues.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The composed prompt
 * @param {string} opts.cwd - Working directory (project root)
 * @param {object} opts.engineConfig - Engine configuration from channels.yaml
 * @param {number} [opts.timeout=300000] - Timeout in ms (default 5 min)
 * @returns {Promise<{reply: string, raw: string}>}
 */
async function callClaude(opts) {
  const { prompt, cwd, engineConfig, timeout = 300000 } = opts;

  const binary = getClaudeBinary();

  // Write prompt to temp file to avoid command-line length limits
  const tmpFile = path.join(os.tmpdir(), `yuri-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt);

  return new Promise((resolve) => {
    const args = [
      '--dangerously-skip-permissions',
      '-p',
      `$(cat "${tmpFile}")`,
    ];

    // Use shell to expand $(cat ...) and get proper PATH
    const child = spawn('zsh', ['-lc', `"${binary}" --dangerously-skip-permissions -p "$(cat "${tmpFile}")"`], {
      cwd: cwd || os.homedir(),
      env: { ...process.env },
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      // Clean up temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      if (stderr.trim()) {
        console.error('[claude-cli] stderr:', stderr.trim().slice(0, 500));
      }

      if (code !== 0 && !stdout.trim()) {
        console.error(`[claude-cli] Process exited with code ${code}`);
        resolve({ reply: `❌ Claude CLI error (exit ${code}). Check gateway logs.`, raw: '' });
        return;
      }

      resolve({ reply: stdout.trim(), raw: stdout });
    });

    child.on('error', (err) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      console.error('[claude-cli] spawn error:', err.message);
      resolve({ reply: `❌ Failed to start Claude CLI: ${err.message}`, raw: '' });
    });
  });
}

/**
 * Compose the full prompt for a channel message.
 *
 * @param {string} userMessage - The user's message text
 * @param {Array} chatHistory - Recent chat messages [{role, text, ts}]
 * @returns {string}
 */
function composePrompt(userMessage, chatHistory) {
  const parts = [];

  // L1 context (pre-loaded global memory)
  const l1 = loadL1Context();
  if (l1) parts.push(l1);

  // Chat history for conversation continuity
  if (chatHistory && chatHistory.length > 0) {
    const historyBlock = chatHistory
      .map((m) => `**${m.role}** (${m.ts}): ${m.text}`)
      .join('\n');
    parts.push(`## Recent Conversation\n\n${historyBlock}`);
  }

  // User message
  parts.push(`## Current Message\n\n${userMessage}`);

  // Instructions for channel mode
  parts.push(
    `## Channel Mode Instructions\n\n` +
    `You are responding via a messaging channel (Telegram/Feishu), not a terminal.\n` +
    `- Keep responses concise and mobile-friendly.\n` +
    `- Use markdown formatting sparingly (Telegram supports basic markdown).\n` +
    `- If you need to perform operations, do so and report the result.\n` +
    `- At the end of your response, if you observed any memory-worthy signals ` +
    `(user preferences, priority changes, tech lessons, corrections), ` +
    `write them to ~/.yuri/inbox.jsonl.\n` +
    `- Update ~/.yuri/focus.yaml and the project's focus.yaml after any operation.`
  );

  return parts.join('\n\n---\n\n');
}

module.exports = { callClaude, composePrompt, loadL1Context, resolveProjectRoot, findClaudeBinary };
