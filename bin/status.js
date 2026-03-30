#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PID_FILE = path.join(os.homedir(), '.yuri', 'gateway.pid');
const SESSION_FILE = path.join(os.homedir(), '.yuri', 'gateway-session.json');

function status() {
  let pid = null;
  let running = false;

  if (fs.existsSync(PID_FILE)) {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  // Check session
  let sessionInfo = 'none';
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const age = Date.now() - new Date(s.savedAt).getTime();
      if (age < 24 * 3600_000) {
        sessionInfo = `${s.sessionId.slice(0, 8)}... (${s.messageCount || 0} messages)`;
        if (s.totalCost) {
          sessionInfo += ` | $${s.totalCost.toFixed(4)}`;
        }
      } else {
        sessionInfo = 'expired';
      }
    } catch { /* ignore */ }
  }

  // Check config
  const configPath = path.join(os.homedir(), '.yuri', 'config', 'channels.yaml');
  let tokenStatus = '\x1b[90mnot set\x1b[0m';
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    if (/token:\s*".+"/.test(content) || /token:\s*'.+'/.test(content)) {
      tokenStatus = '\x1b[32mconfigured\x1b[0m';
    }
  }

  console.log('');
  console.log('  Yuri Gateway Status');
  console.log('  ───────────────────');
  console.log(`  Gateway process:  ${running ? `\x1b[32mrunning\x1b[0m (PID ${pid})` : '\x1b[90mnot running\x1b[0m'}`);
  console.log(`  Claude session:   ${sessionInfo}`);
  console.log(`  Telegram token:   ${tokenStatus}`);
  console.log('');
}

status();
