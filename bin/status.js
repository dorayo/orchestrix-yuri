#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PID_FILE = path.join(os.homedir(), '.yuri', 'gateway.pid');

function status() {
  // Check PID
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

  // Check tmux session
  let tmuxAlive = false;
  try {
    execSync('tmux has-session -t yuri-gateway 2>/dev/null');
    tmuxAlive = true;
  } catch {
    tmuxAlive = false;
  }

  console.log('');
  console.log('  Yuri Gateway Status');
  console.log('  ───────────────────');
  console.log(`  Gateway process:  ${running ? `\x1b[32mrunning\x1b[0m (PID ${pid})` : '\x1b[90mnot running\x1b[0m'}`);
  console.log(`  tmux session:     ${tmuxAlive ? '\x1b[32myuri-gateway (active)\x1b[0m' : '\x1b[90mnone\x1b[0m'}`);

  // Check config
  const configPath = path.join(os.homedir(), '.yuri', 'config', 'channels.yaml');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    const hasToken = /token:\s*".+"/.test(content) || /token:\s*'.+'/.test(content);
    console.log(`  Telegram token:   ${hasToken ? '\x1b[32mconfigured\x1b[0m' : '\x1b[90mnot set\x1b[0m'}`);
  } else {
    console.log('  Config:           \x1b[90mnot found\x1b[0m');
  }

  console.log('');
}

status();
