'use strict';

const lark = require('@larksuiteoapi/node-sdk');
const { log } = require('../log');

/**
 * Feishu (Lark) channel adapter using WebSocket long connection.
 * Uses @larksuiteoapi/node-sdk for event subscription and REST API.
 */
class FeishuAdapter {
  constructor(opts) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.onMessage = opts.onMessage;
    this.client = null;    // lark.Client — REST API (send/edit/delete)
    this.wsClient = null;  // lark.WSClient — WebSocket event receiver
  }

  async start() {
    if (!this.appId || !this.appSecret) {
      throw new Error('Feishu App ID and App Secret are required. Run: orchestrix-yuri start --feishu-id ID --feishu-secret SECRET');
    }

    // REST API client (token auto-managed by SDK)
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    });

    // Event dispatcher — register message handler
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this._handleMessage(data);
      },
    });

    // WebSocket long connection (no public IP needed)
    log.feishu('Connecting via WebSocket...');
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.WARN,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    log.feishu('Connected via WebSocket');
  }

  async stop() {
    if (this.wsClient) {
      // SDK may not expose close() — attempt gracefully
      if (typeof this.wsClient.close === 'function') {
        await this.wsClient.close();
      } else if (typeof this.wsClient.stop === 'function') {
        await this.wsClient.stop();
      }
      this.wsClient = null;
    }
    log.feishu('Adapter stopped');
  }

  // ── Message Handling ─────────────────────────────────────────────────────────

  async _handleMessage(data) {
    try {
      const message = data.message;
      if (!message) return;

      // Only handle text messages
      if (message.message_type !== 'text') return;

      // Parse message content
      let text = '';
      try {
        const content = JSON.parse(message.content);
        text = content.text || '';
      } catch { return; }

      // Strip @bot mention prefix (Feishu adds @_user_N in group chats)
      text = text.replace(/@_user_\d+\s*/g, '').trim();
      if (!text) return;

      const msg = {
        channelType: 'feishu',
        channelUserId: data.sender.sender_id.user_id || data.sender.sender_id.open_id,
        chatId: message.chat_id,
        text,
        userName: data.sender.sender_id.user_id || 'Unknown',
        replyToMessageId: message.parent_id || null,
      };

      // Send placeholder immediately
      const placeholder = await this._sendMessage(msg.chatId, '...').catch(() => null);

      const reply = await this.onMessage(msg);

      if (reply && reply.text) {
        // Feishu does NOT support editing text messages (only cards).
        // Always delete placeholder and send reply as new message.
        if (placeholder) await this._deleteMessage(placeholder.messageId).catch(() => {});

        const chunks = splitMessage(reply.text, 4000);
        for (const chunk of chunks) {
          await this._sendMessage(msg.chatId, chunk).catch(() => {});
        }
      } else if (placeholder) {
        await this._deleteMessage(placeholder.messageId).catch(() => {});
      }
    } catch (err) {
      log.error(`Feishu message handling failed: ${err.message}`);
    }
  }

  // ── API Helpers ──────────────────────────────────────────────────────────────

  async _sendMessage(chatId, text) {
    const resp = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    const msgId = resp.data && resp.data.message_id;
    return { messageId: msgId ? String(msgId) : null };
  }

  async _replyMessage(messageId, text) {
    const resp = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    const msgId = resp.data && resp.data.message_id;
    return { messageId: msgId ? String(msgId) : null };
  }

  async _deleteMessage(messageId) {
    await this.client.im.message.delete({
      path: { message_id: messageId },
    });
  }
}

/**
 * Split a long message into chunks.
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

    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx < maxLength * 0.3) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

module.exports = { FeishuAdapter };
