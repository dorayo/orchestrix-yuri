#!/usr/bin/env node
'use strict';

const { install } = require('../lib/installer');

const args = process.argv.slice(2);
const command = args[0];

if (command === 'install') {
  install();
} else if (command === '--help' || command === '-h' || !command) {
  console.log(`
  orchestrix-yuri — Meta-Orchestrator for Orchestrix

  Usage:
    npx orchestrix-yuri install    Install Yuri skill globally (~/.claude/skills/yuri/)
    npx orchestrix-yuri --help     Show this help message

  After installation, type /yuri in any Claude Code session to activate.
  `);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "npx orchestrix-yuri --help" for usage information.');
  process.exit(1);
}
