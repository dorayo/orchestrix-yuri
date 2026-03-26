#!/usr/bin/env node
'use strict';

const { startGateway } = require('../lib/gateway');

// Parse CLI arguments
const args = process.argv.slice(2);
const opts = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--telegram-token' && args[i + 1]) {
    opts.telegramToken = args[++i];
  } else if (args[i] === '--port' && args[i + 1]) {
    opts.port = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
  orchestrix-yuri serve — Start the Yuri Channel Gateway

  Usage:
    npx orchestrix-yuri serve [options]

  Options:
    --telegram-token TOKEN   Telegram Bot API token (overrides config)
    --port PORT              Server port (default: 7890)
    --help                   Show this help message

  Configuration:
    Edit ~/.yuri/config/channels.yaml to configure channels persistently.

  Examples:
    npx orchestrix-yuri serve --telegram-token "123456:ABC-DEF..."
    npx orchestrix-yuri serve
    `);
    process.exit(0);
  }
}

startGateway(opts).catch((err) => {
  console.error('  ❌ Gateway failed:', err.message);
  process.exit(1);
});
