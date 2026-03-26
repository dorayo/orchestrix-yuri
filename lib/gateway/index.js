'use strict';

const { loadConfig, applyCliOverrides } = require('./config');
const { Router } = require('./router');
const { TelegramAdapter } = require('./channels/telegram');

/**
 * Start the Yuri Gateway.
 *
 * @param {object} opts - CLI options
 * @param {string} [opts.telegramToken] - Override Telegram token
 * @param {string} [opts.port] - Override server port
 */
async function startGateway(opts = {}) {
  console.log('');
  console.log('  🚀 Yuri Gateway starting...');
  console.log('');

  // Load and merge config
  let config = loadConfig();
  config = applyCliOverrides(config, opts);

  // Create router (handles message processing + engine orchestration)
  const router = new Router(config);
  const messageHandler = (msg) => router.handleMessage(msg);

  // Track active adapters for graceful shutdown
  const adapters = [];

  // Start Telegram adapter if enabled
  if (config.channels.telegram.enabled && config.channels.telegram.token) {
    const telegram = new TelegramAdapter({
      token: config.channels.telegram.token,
      onMessage: messageHandler,
    });
    adapters.push(telegram);

    try {
      await telegram.start();
    } catch (err) {
      console.error(`  ❌ Telegram failed to start: ${err.message}`);
      process.exit(1);
    }
  }

  // Start Feishu adapter if enabled (placeholder)
  if (config.channels.feishu.enabled) {
    console.log('  ⚠️  Feishu adapter not yet implemented. Skipping.');
  }

  // Check if any channel is active
  if (adapters.length === 0) {
    console.error('');
    console.error('  ❌ No channels enabled. Configure at least one:');
    console.error('');
    console.error('    npx orchestrix-yuri serve --telegram-token YOUR_BOT_TOKEN');
    console.error('');
    console.error('  Or edit ~/.yuri/config/channels.yaml');
    console.error('');
    process.exit(1);
  }

  console.log('');
  console.log('  Yuri Gateway is running. Press Ctrl+C to stop.');
  console.log('');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  Shutting down Yuri Gateway...');
    for (const adapter of adapters) {
      await adapter.stop().catch(() => {});
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startGateway };
