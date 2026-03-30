'use strict';

const { Bot } = require('grammy');
const { log } = require('../log');

/**
 * Telegram channel adapter using grammy (polling mode).
 */
class TelegramAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.token - Telegram Bot API token
   * @param {function} opts.onMessage - Handler: (msg: YuriMessage) => Promise<YuriReply>
   */
  constructor(opts) {
    this.token = opts.token;
    this.onMessage = opts.onMessage;
    this.bot = null;
  }

  async start() {
    if (!this.token) {
      throw new Error('Telegram bot token is required. Run: orchestrix-yuri start --token YOUR_TOKEN');
    }

    this.bot = new Bot(this.token);

    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      const msg = {
        channelType: 'telegram',
        channelUserId: String(ctx.from.id),
        chatId: String(ctx.chat.id),
        text: ctx.message.text,
        userName: ctx.from.first_name || ctx.from.username || 'Unknown',
      };

      try {
        const reply = await this.onMessage(msg);
        if (reply && reply.text) {
          // Telegram has a 4096 char limit per message
          const chunks = splitMessage(reply.text, 4000);
          for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {
              // Fallback: send without markdown if parsing fails
              return ctx.reply(chunk);
            });
          }
        }
      } catch (err) {
        log.error(`Message handling failed: ${err.message}`);
        await ctx.reply('❌ Internal error. Check Yuri Gateway logs.').catch(() => {});
      }
    });

    // Handle /start command (for binding flow)
    this.bot.command('start', async (ctx) => {
      const msg = {
        channelType: 'telegram',
        channelUserId: String(ctx.from.id),
        chatId: String(ctx.chat.id),
        text: '/start',
        userName: ctx.from.first_name || ctx.from.username || 'Unknown',
      };

      const reply = await this.onMessage(msg);
      if (reply && reply.text) {
        await ctx.reply(reply.text, { parse_mode: 'Markdown' }).catch(() => {
          return ctx.reply(reply.text);
        });
      }
    });

    // Error handler
    this.bot.catch((err) => {
      const msg = err.message || String(err);
      if (msg.includes('409') || msg.includes('Conflict')) {
        log.error('Polling conflict — another instance is using this token.');
        log.info('This instance will exit. Stop the other process and restart.');
        process.exit(1);
      }
      log.warn(`Bot error: ${msg}`);
    });

    // Clear any stale webhook/polling before starting
    log.telegram('Connecting...');
    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true });
    } catch {
      // ignore — not critical
    }

    // Start polling
    await this.bot.start({
      drop_pending_updates: true,
      onStart: (botInfo) => {
        log.telegram(`Bot @${botInfo.username} is live (polling mode)`);
      },
    });
  }

  async stop() {
    if (this.bot) {
      await this.bot.stop();
      log.telegram('Bot stopped');
    }
  }
}

/**
 * Split a long message into chunks for Telegram's 4096 char limit.
 */
function splitMessage(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength * 0.5) {
      // If no good newline, split at space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength * 0.3) {
      // Hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

module.exports = { TelegramAdapter };
