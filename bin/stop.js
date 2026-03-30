#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const PID_FILE = path.join(os.homedir(), '.yuri', 'gateway.pid');

function stop() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('  No gateway is running (no PID file found).');
    process.exit(0);
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);

  // Check if process is alive
  try {
    process.kill(pid, 0); // signal 0 = just check existence
  } catch {
    console.log(`  Gateway PID ${pid} is not running. Cleaning up stale PID file.`);
    fs.unlinkSync(PID_FILE);
    process.exit(0);
  }

  // Send SIGTERM for graceful shutdown
  console.log(`  Stopping gateway (PID ${pid})...`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`  ❌ Failed to stop: ${err.message}`);
    process.exit(1);
  }

  // Wait briefly then verify
  setTimeout(() => {
    try {
      process.kill(pid, 0);
      // Still alive, force kill
      console.log('  Process did not exit gracefully, sending SIGKILL...');
      process.kill(pid, 'SIGKILL');
    } catch {
      // Dead, good
    }
    try { fs.unlinkSync(PID_FILE); } catch {}
    console.log('  ✅ Gateway stopped.');
  }, 2000);
}

stop();
