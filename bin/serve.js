#!/usr/bin/env node
'use strict';

const { startGateway } = require('../lib/gateway');

// Parse CLI arguments
const args = process.argv.slice(2);
const opts = {};

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--telegram-token' || args[i] === '--token' || args[i] === '-t') && args[i + 1]) {
    opts.telegramToken = args[++i];
  } else if (args[i] === '--feishu-id' && args[i + 1]) {
    opts.feishuAppId = args[++i];
  } else if (args[i] === '--feishu-secret' && args[i + 1]) {
    opts.feishuAppSecret = args[++i];
  } else if (args[i] === '--port' && args[i + 1]) {
    opts.port = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
  orchestrix-yuri start — Start the Yuri Channel Gateway

  Usage:
    orchestrix-yuri start [options]

  Options:
    --token, -t TOKEN       Telegram Bot token (saved to config, only needed once)
    --feishu-id ID          Feishu App ID (saved to config, only needed once)
    --feishu-secret SECRET  Feishu App Secret (saved to config, only needed once)
    --port PORT             Server port (default: 7890)
    --help                  Show this help message

  Examples:
    orchestrix-yuri start --token "123456:ABC-DEF..."                        # Telegram
    orchestrix-yuri start --feishu-id "cli_xxx" --feishu-secret "yyy"        # Feishu
    orchestrix-yuri start                                                     # after config saved
    `);
    process.exit(0);
  }
}

startGateway(opts).catch((err) => {
  console.error('  ❌ Gateway failed:', err.message);
  process.exit(1);
});
