'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const execFileAsync = promisify(execFile);

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
 * Find the CLI command (cc or claude).
 */
function findCliCommand(engineConfig) {
  const { cli_command, fallback_command } = engineConfig;

  // Check if primary command exists via which
  try {
    require('child_process').execSync(`which ${cli_command} 2>/dev/null`);
    return cli_command;
  } catch {
    // Try fallback
    try {
      require('child_process').execSync(`which ${fallback_command} 2>/dev/null`);
      return fallback_command;
    } catch {
      return cli_command; // Return primary anyway, let it fail with a clear error
    }
  }
}

/**
 * Execute a Claude CLI call with the Yuri skill.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The composed prompt (L1 context + chat history + user message)
 * @param {string} opts.cwd - Working directory (project root)
 * @param {object} opts.engineConfig - Engine configuration from channels.yaml
 * @param {number} [opts.timeout=300000] - Timeout in ms (default 5 min)
 * @returns {Promise<{reply: string, raw: string}>}
 */
async function callClaude(opts) {
  const { prompt, cwd, engineConfig, timeout = 300000 } = opts;

  const cmd = findCliCommand(engineConfig);
  const args = [
    '-p', prompt,
    '--allowedTools', engineConfig.allowed_tools || 'Read,Write,Edit,Bash,Glob,Grep',
  ];

  const execOpts = {
    cwd: cwd || os.homedir(),
    timeout,
    maxBuffer: 10 * 1024 * 1024, // 10MB
    env: { ...process.env },
  };

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, execOpts);

    if (stderr && stderr.trim()) {
      console.error('[claude-cli] stderr:', stderr.trim().slice(0, 500));
    }

    const reply = stdout.trim();
    return { reply, raw: stdout };
  } catch (err) {
    if (err.killed) {
      return { reply: '⏰ Request timed out. The operation took too long.', raw: '' };
    }
    console.error('[claude-cli] error:', err.message);
    return { reply: `❌ Error: ${err.message.slice(0, 200)}`, raw: '' };
  }
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

module.exports = { callClaude, composePrompt, loadL1Context, resolveProjectRoot, findCliCommand };
