'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(os.homedir(), '.yuri', 'config', 'channels.yaml');

const DEFAULTS = {
  server: { port: 7890 },
  channels: {
    telegram: { enabled: false, token: '', mode: 'polling', owner_chat_id: '' },
    feishu: { enabled: false, app_id: '', app_secret: '', webhook_url: '', owner_user_id: '' },
  },
  chat_history: {
    max_messages: 20,
    storage: path.join(os.homedir(), '.yuri', 'chat-history'),
  },
  engine: {
    skill: 'yuri',
    timeout: 300000,              // per-message timeout (5 min)
    autocompact_pct: 80,          // trigger auto-compact at this % (default 95%)
    compact_every: 50,            // proactive /compact after N messages
  },
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULTS;
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = yaml.load(raw) || {};

  // Deep merge with defaults
  return {
    server: { ...DEFAULTS.server, ...parsed.server },
    channels: {
      telegram: { ...DEFAULTS.channels.telegram, ...(parsed.channels && parsed.channels.telegram) },
      feishu: { ...DEFAULTS.channels.feishu, ...(parsed.channels && parsed.channels.feishu) },
    },
    chat_history: {
      ...DEFAULTS.chat_history,
      ...parsed.chat_history,
      storage: (parsed.chat_history && parsed.chat_history.storage)
        ? parsed.chat_history.storage.replace('~', os.homedir())
        : DEFAULTS.chat_history.storage,
    },
    engine: { ...DEFAULTS.engine, ...(parsed.engine || {}) },
  };
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: -1 }));
}

function applyCliOverrides(config, opts) {
  let shouldSave = false;

  if (opts.telegramToken) {
    config.channels.telegram.enabled = true;
    config.channels.telegram.token = opts.telegramToken;
    shouldSave = true;
  }
  if (opts.port) {
    config.server.port = parseInt(opts.port, 10);
  }

  // Persist token to channels.yaml so user only needs to pass it once
  if (shouldSave) {
    saveConfig(config);
    const { log } = require('./log');
    log.ok('Token saved to ~/.yuri/config/channels.yaml');
    log.info('Next time just run: orchestrix-yuri start');
    console.log('');
  }

  return config;
}

module.exports = { loadConfig, saveConfig, applyCliOverrides, CONFIG_PATH };
