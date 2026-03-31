'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, applyCliOverrides } = require('./config');
const { Router } = require('./router');
const { TelegramAdapter } = require('./channels/telegram');
const { log, c } = require('./log');

const PID_FILE = path.join(os.homedir(), '.yuri', 'gateway.pid');

/**
 * Start the Yuri Gateway.
 *
 * @param {object} opts - CLI options
 * @param {string} [opts.telegramToken] - Override Telegram token
 * @param {string} [opts.port] - Override server port
 */
async function startGateway(opts = {}) {
  log.banner('🚀 Yuri Gateway starting...');

  // Load and merge config
  let config = loadConfig();
  config = applyCliOverrides(config, opts);

  // Create router (handles message processing + engine orchestration)
  const router = new Router(config);
  const messageHandler = (msg) => router.handleMessage(msg);

  // Track active adapters for graceful shutdown
  const adapters = [];

  // Start Telegram adapter if token present (auto-enable)
  if (config.channels.telegram.token) {
    config.channels.telegram.enabled = true;
  }
  if (config.channels.telegram.enabled && config.channels.telegram.token) {
    const telegram = new TelegramAdapter({
      token: config.channels.telegram.token,
      onMessage: messageHandler,
    });
    adapters.push(telegram);

    // Wire proactive messaging: orchestrator → Telegram (returns { messageId })
    router.setSendCallback('telegram', async (chatId, text) => {
      try {
        const sent = await telegram.bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        return { messageId: String(sent.message_id) };
      } catch {
        try {
          const sent = await telegram.bot.api.sendMessage(chatId, text);
          return { messageId: String(sent.message_id) };
        } catch { return null; }
      }
    });

    try {
      await telegram.start();
    } catch (err) {
      if (err.message.includes('409') || err.message.includes('Conflict')) {
        log.error('Another bot instance is already running with this token.');
        log.info('Run: orchestrix-yuri stop');
      } else {
        log.error(`Telegram failed to start: ${err.message}`);
      }
      process.exit(1);
    }
  }

  // Start Feishu adapter if credentials present (auto-enable)
  const feishuHasCreds = config.channels.feishu.app_id && config.channels.feishu.app_secret;
  if (feishuHasCreds) {
    config.channels.feishu.enabled = true;
  }
  if (config.channels.feishu.enabled && feishuHasCreds) {
    const { FeishuAdapter } = require('./channels/feishu');
    const feishu = new FeishuAdapter({
      appId: config.channels.feishu.app_id,
      appSecret: config.channels.feishu.app_secret,
      onMessage: messageHandler,
    });
    adapters.push(feishu);

    // Wire proactive messaging: orchestrator → Feishu
    router.setSendCallback('feishu', async (chatId, text) => {
      try {
        return await feishu._sendMessage(chatId, text);
      } catch { return null; }
    });

    try {
      await feishu.start();
    } catch (err) {
      log.error(`Feishu failed to start: ${err.message}`);
      log.info('Telegram will continue running. Fix Feishu config and restart.');
      // Don't exit — let Telegram continue if it's also running
    }
  }

  // Check if any channel is active
  if (adapters.length === 0) {
    console.error('');
    log.error('No channels enabled. Set up your Telegram bot token:');
    console.error('');
    console.error(`    ${c.cyan}orchestrix-yuri start --token YOUR_BOT_TOKEN${c.reset}`);
    console.error('');
    log.info('The token is saved automatically. After that, just run:');
    console.error('');
    console.error(`    ${c.cyan}orchestrix-yuri start${c.reset}`);
    console.error('');
    process.exit(1);
  }

  // Write PID file for `orchestrix-yuri stop`
  fs.writeFileSync(PID_FILE, String(process.pid));

  log.banner('Yuri Gateway is running. Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('');
    log.info('Shutting down Yuri Gateway...');
    await router.shutdown();
    for (const adapter of adapters) {
      await adapter.stop().catch(() => {});
    }
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { startGateway };
