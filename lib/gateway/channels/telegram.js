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
        replyToMessageId: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : null,
      };

      try {
        // Send placeholder immediately so user sees instant feedback
        const placeholder = await ctx.reply('...').catch(() => null);

        const reply = await this.onMessage(msg);
        if (reply && reply.text) {
          const chunks = splitMessage(reply.text, 4000);

          if (placeholder && chunks.length === 1) {
            // Single chunk: try to edit placeholder in-place
            let edited = false;
            try {
              await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, chunks[0], { parse_mode: 'Markdown' });
              edited = true;
            } catch {
              // Markdown parse failed — try without parse_mode
              try {
                await ctx.api.editMessageText(ctx.chat.id, placeholder.message_id, chunks[0]);
                edited = true;
              } catch (editErr) {
                log.warn(`Edit failed: ${editErr.message}`);
              }
            }

            // Edit failed entirely — delete placeholder and send as new message
            if (!edited) {
              await ctx.api.deleteMessage(ctx.chat.id, placeholder.message_id).catch(() => {});
              await ctx.reply(chunks[0], { parse_mode: 'Markdown' }).catch(() => {
                return ctx.reply(chunks[0]);
              });
            }
          } else {
            // Multi-chunk: delete placeholder, send chunks separately
            if (placeholder) {
              await ctx.api.deleteMessage(ctx.chat.id, placeholder.message_id).catch(() => {});
            }
            for (const chunk of chunks) {
              await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() => {
                return ctx.reply(chunk);
              });
            }
          }
        } else if (placeholder) {
          // No reply: remove placeholder
          await ctx.api.deleteMessage(ctx.chat.id, placeholder.message_id).catch(() => {});
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

    // Force-disconnect any stale polling connection before starting.
    // deleteWebhook only clears webhooks, NOT existing long-polling connections.
    // A direct getUpdates call with timeout=0 "steals" the polling slot,
    // terminating any other instance's connection.
    log.telegram('Connecting...');
    await forceDisconnectPolling(this.token);

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

/**
 * Force-disconnect any stale polling session via direct Telegram API calls.
 * Uses native https to avoid grammy API quirks.
 */
function forceDisconnectPolling(token) {
  const https = require('https');

  const call = (method, body) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });

  return (async () => {
    await call('deleteWebhook', { drop_pending_updates: true });
    await call('getUpdates', { offset: -1, limit: 1, timeout: 0 });
    // Brief pause to let Telegram release the polling slot
    await new Promise((r) => setTimeout(r, 1000));
  })();
}

module.exports = { TelegramAdapter };
