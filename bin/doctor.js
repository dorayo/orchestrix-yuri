#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const YURI_GLOBAL = path.join(HOME, '.yuri');
const SKILL_DIR = path.join(HOME, '.claude', 'skills', 'yuri');

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[90m', bold: '\x1b[1m',
};

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function pass(msg) { passCount++; console.log(`  ${c.green}✅${c.reset} ${msg}`); }
function fail(msg, fix) {
  failCount++;
  console.log(`  ${c.red}❌${c.reset} ${msg}`);
  if (fix) console.log(`     ${c.dim}Fix: ${fix}${c.reset}`);
}
function warn(msg) { warnCount++; console.log(`  ${c.yellow}⚠️${c.reset}  ${msg}`); }
function info(msg) { console.log(`  ${c.dim}ℹ  ${msg}${c.reset}`); }
function section(title) { console.log(`\n  ${c.bold}${c.cyan}${title}${c.reset}`); }

function cmd(command) {
  try { return execSync(command, { encoding: 'utf8', timeout: 10000 }).trim(); } catch { return null; }
}

function fileExists(p) { return fs.existsSync(p); }
function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// ── Checks ─────────────────────────────────────────────────────────────────────

function checkRuntime() {
  section('1. Runtime Environment');

  // Node.js
  const nodeV = cmd('node --version');
  if (nodeV) {
    const major = parseInt(nodeV.replace('v', ''), 10);
    if (major >= 18) pass(`Node.js ${nodeV}`);
    else fail(`Node.js ${nodeV} (requires >= 18)`, 'Upgrade Node.js to v18+');
  } else {
    fail('Node.js not found', 'Install Node.js >= 18');
  }

  // tmux
  const tmuxV = cmd('tmux -V');
  if (tmuxV) pass(`tmux ${tmuxV}`);
  else fail('tmux not found', 'brew install tmux (macOS) or apt install tmux (Linux)');

  // zsh (needed for claude binary resolution)
  const zshV = cmd('zsh --version');
  if (zshV) pass(`zsh available`);
  else warn('zsh not found — Claude binary resolution may fail on some systems');

  // git
  const gitV = cmd('git --version');
  if (gitV) pass(`git available`);
  else warn('git not found — project creation requires git');
}

function checkClaude() {
  section('2. Claude Code CLI');

  const candidates = [
    cmd('zsh -lc "which claude" 2>/dev/null'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(HOME, '.npm-global', 'bin', 'claude'),
    path.join(HOME, '.local', 'bin', 'claude'),
    path.join(HOME, '.claude', 'bin', 'claude'),
  ].filter(Boolean);

  let found = null;
  for (const p of candidates) {
    if (fileExists(p)) { found = p; break; }
  }

  if (found) {
    pass(`Claude binary: ${found}`);
    const version = cmd(`"${found}" --version 2>/dev/null`);
    if (version) pass(`Claude Code ${version}`);
    else warn('Could not get Claude Code version');
  } else {
    fail('Claude Code CLI not found', 'npm install -g @anthropic-ai/claude-code');
  }
}

function checkInstallation() {
  section('3. Yuri Installation');

  // Skill files
  const skillMd = path.join(SKILL_DIR, 'SKILL.md');
  if (fileExists(skillMd)) {
    const size = fs.statSync(skillMd).size;
    if (size > 100) pass(`SKILL.md (${(size / 1024).toFixed(1)}KB)`);
    else warn('SKILL.md exists but seems empty');
  } else {
    fail('SKILL.md not found', 'orchestrix-yuri install');
  }

  // Scripts
  const scripts = ['ensure-session.sh', 'monitor-agent.sh', 'scan-stories.sh', 'start-planning.sh'];
  const scriptDir = path.join(SKILL_DIR, 'scripts');
  for (const s of scripts) {
    const p = path.join(scriptDir, s);
    if (fileExists(p)) {
      if (isExecutable(p)) pass(`scripts/${s}`);
      else warn(`scripts/${s} exists but not executable`);
    } else {
      warn(`scripts/${s} missing`);
    }
  }

  // Resources
  const resources = ['start-orchestrix.sh', 'handoff-detector.sh', 'settings.local.json'];
  const resDir = path.join(SKILL_DIR, 'resources');
  for (const r of resources) {
    const p = path.join(resDir, r);
    if (fileExists(p)) pass(`resources/${r}`);
    else warn(`resources/${r} missing`);
  }
}

function checkMemory() {
  section('4. Global Memory (~/.yuri/)');

  if (!fileExists(YURI_GLOBAL)) {
    fail('~/.yuri/ directory not found', 'orchestrix-yuri install');
    return;
  }
  pass('~/.yuri/ directory exists');

  const required = [
    ['self.yaml', 'Yuri identity'],
    ['boss/profile.yaml', 'Boss profile'],
    ['boss/preferences.yaml', 'Boss preferences'],
    ['portfolio/registry.yaml', 'Project registry'],
    ['focus.yaml', 'Global focus'],
    ['config/channels.yaml', 'Channel config'],
  ];

  for (const [rel, label] of required) {
    const p = path.join(YURI_GLOBAL, rel);
    if (fileExists(p)) pass(`${rel}`);
    else fail(`${rel} missing (${label})`, 'orchestrix-yuri install');
  }

  // Check inbox
  const inboxPath = path.join(YURI_GLOBAL, 'inbox.jsonl');
  if (fileExists(inboxPath)) {
    const content = fs.readFileSync(inboxPath, 'utf8').trim();
    const lines = content ? content.split('\n').length : 0;
    const unprocessed = content ? content.split('\n').filter((l) => l.includes('"processed":false')).length : 0;
    pass(`inbox.jsonl (${lines} entries, ${unprocessed} unprocessed)`);
  } else {
    warn('inbox.jsonl not found');
  }

  // Check wisdom
  const wisdomDir = path.join(YURI_GLOBAL, 'wisdom');
  if (fileExists(wisdomDir)) pass('wisdom/ directory');
  else warn('wisdom/ directory missing');

  // Chat history
  const historyDir = path.join(YURI_GLOBAL, 'chat-history');
  if (fileExists(historyDir)) pass('chat-history/ directory');
  else warn('chat-history/ directory missing');
}

function checkConfig() {
  section('5. Gateway Configuration');

  const configPath = path.join(YURI_GLOBAL, 'config', 'channels.yaml');
  if (!fileExists(configPath)) {
    fail('channels.yaml not found', 'orchestrix-yuri install');
    return;
  }

  try {
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};

    // Telegram
    const tg = config.channels && config.channels.telegram;
    if (tg && tg.enabled && tg.token) {
      if (tg.token.includes(':')) pass(`Telegram token configured (${tg.token.slice(0, 8)}...)`);
      else warn('Telegram token format looks invalid (expected BOT_ID:TOKEN)');
    } else if (tg && tg.enabled && !tg.token) {
      fail('Telegram enabled but token is empty', 'orchestrix-yuri start --token YOUR_TOKEN');
    } else {
      info('Telegram not enabled');
    }

    // Owner binding
    if (tg && tg.owner_chat_id) {
      pass(`Owner bound: chat ${tg.owner_chat_id}`);
    } else {
      info('No owner bound yet (will auto-bind on first /start)');
    }

    // Engine
    const engine = config.engine || {};
    info(`Timeout: ${(engine.timeout || 300000) / 1000}s, Compact every: ${engine.compact_every || 50} msgs`);

  } catch (err) {
    fail(`channels.yaml parse error: ${err.message}`);
  }
}

function checkGatewayState() {
  section('6. Gateway State');

  // PID file
  const pidPath = path.join(YURI_GLOBAL, 'gateway.pid');
  if (fileExists(pidPath)) {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      pass(`Gateway running (PID ${pid})`);
    } catch {
      warn(`Stale PID file (process ${pid} not running)`);
    }
  } else {
    info('Gateway not running');
  }

  // Session state
  const sessionPath = path.join(YURI_GLOBAL, 'gateway-session.json');
  if (fileExists(sessionPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      const age = Date.now() - new Date(s.savedAt).getTime();
      const ageH = (age / 3600000).toFixed(1);
      if (age < 24 * 3600000) {
        pass(`Session: ${s.sessionId.slice(0, 8)}... (${s.messageCount || 0} msgs, ${ageH}h old, $${(s.totalCost || 0).toFixed(4)})`);
      } else {
        warn(`Session expired (${ageH}h old)`);
      }
    } catch {
      warn('Session file corrupted');
    }
  } else {
    info('No session state (will create on first message)');
  }

  // tmux sessions
  const tmuxList = cmd('tmux list-sessions -F "#{session_name}" 2>/dev/null');
  if (tmuxList) {
    const sessions = tmuxList.split('\n').filter((s) => s.startsWith('op-') || s.startsWith('orchestrix-'));
    if (sessions.length > 0) {
      for (const s of sessions) {
        info(`Active tmux session: ${s}`);
      }
    }
  }
}

function checkProjects() {
  section('7. Projects');

  const registryPath = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
  if (!fileExists(registryPath)) {
    info('No project registry');
    return;
  }

  try {
    const yaml = require('js-yaml');
    const registry = yaml.load(fs.readFileSync(registryPath, 'utf8')) || {};
    const projects = registry.projects || [];

    if (projects.length === 0) {
      info('No projects registered. Use *create to create one.');
      return;
    }

    for (const p of projects) {
      const rootExists = p.root && fileExists(p.root);
      const status = rootExists ? `${p.status || '?'} (Phase ${p.phase || '?'})` : 'root directory missing!';
      if (rootExists) pass(`${p.name || p.id}: ${status}`);
      else fail(`${p.name || p.id}: ${status}`);
    }

    // Active project
    const focusPath = path.join(YURI_GLOBAL, 'focus.yaml');
    if (fileExists(focusPath)) {
      const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
      if (focus.active_project) {
        info(`Active project: ${focus.active_project}`);
      }
    }
  } catch { /* ok */ }
}

function checkNetwork() {
  section('8. Network');

  // Telegram API
  const configPath = path.join(YURI_GLOBAL, 'config', 'channels.yaml');
  if (fileExists(configPath)) {
    try {
      const yaml = require('js-yaml');
      const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
      const tg = config.channels && config.channels.telegram;

      if (tg && tg.enabled && tg.token) {
        const result = cmd(`curl -s -o /dev/null -w "%{http_code}" "https://api.telegram.org/bot${tg.token}/getMe" 2>/dev/null`);
        if (result === '200') pass('Telegram API reachable + token valid');
        else if (result === '401') fail('Telegram token is invalid (401)', 'Check your bot token with @BotFather');
        else if (result) warn(`Telegram API returned HTTP ${result}`);
        else warn('Cannot reach api.telegram.org (network issue?)');
      }
    } catch { /* ok */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

function doctor() {
  console.log(`\n  ${c.bold}Orchestrix Yuri — Health Check${c.reset}\n`);

  checkRuntime();
  checkClaude();
  checkInstallation();
  checkMemory();
  checkConfig();
  checkGatewayState();
  checkProjects();
  checkNetwork();

  // Summary
  console.log(`\n  ${c.bold}Summary${c.reset}`);
  console.log(`  ${c.green}✅ ${passCount} passed${c.reset}  ${failCount > 0 ? c.red : c.dim}❌ ${failCount} failed${c.reset}  ${warnCount > 0 ? c.yellow : c.dim}⚠️  ${warnCount} warnings${c.reset}`);

  if (failCount === 0) {
    console.log(`\n  ${c.green}${c.bold}All critical checks passed!${c.reset}\n`);
  } else {
    console.log(`\n  ${c.red}${failCount} issue(s) need attention. Fix them and run doctor again.${c.reset}\n`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

doctor();
