#!/usr/bin/env node
'use strict';

const { install } = require('../lib/installer');
const { migrate } = require('../lib/migrate');

const args = process.argv.slice(2);
const command = args[0];

if (command === 'install') {
  install();
} else if (command === 'migrate') {
  const projectRoot = args[1] || process.cwd();
  migrate(projectRoot);
} else if (command === 'start' || command === 'serve') {
  require('./serve');
} else if (command === 'stop') {
  require('./stop');
} else if (command === 'status') {
  require('./status');
} else if (command === 'doctor') {
  require('./doctor');
} else if (command === '--version' || command === '-v' || command === '-V') {
  const { version } = require('../package.json');
  console.log(version);
} else if (command === '--help' || command === '-h' || !command) {
  console.log(`
  orchestrix-yuri — Meta-Orchestrator for Orchestrix

  Usage:
    orchestrix-yuri install                    Install Yuri skill + global memory
    orchestrix-yuri start                      Start the Channel Gateway
    orchestrix-yuri start --token TOKEN        Start & save Telegram Bot token (first time only)
    orchestrix-yuri start --feishu-id ID --feishu-secret SEC  Start & save Feishu credentials
    orchestrix-yuri stop                       Stop the running gateway
    orchestrix-yuri status                     Show gateway status
    orchestrix-yuri doctor                     Health check all dependencies & config
    orchestrix-yuri migrate [path]             Migrate legacy memory.yaml
    orchestrix-yuri --version                  Show version
    orchestrix-yuri --help                     Show this help message

  Quick start:
    orchestrix-yuri install
    orchestrix-yuri start --token "123456:ABC-DEF..."   # first time, saves token
    orchestrix-yuri start                                # from now on, just this

  After installation, type /yuri in any Claude Code session to activate.
  `);
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Run "orchestrix-yuri --help" for usage information.');
  process.exit(1);
}
