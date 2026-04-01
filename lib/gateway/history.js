'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Chat history manager.
 * Stores recent messages per chat_id as JSONL files in the storage directory.
 */
class ChatHistory {
  /**
   * @param {object} opts
   * @param {string} opts.storageDir - Directory to store chat history files
   * @param {number} opts.maxMessages - Maximum messages to retain per chat
   */
  constructor(opts) {
    this.storageDir = opts.storageDir;
    this.maxMessages = opts.maxMessages || 20;

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  _filePath(chatId) {
    const safeId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `${safeId}.jsonl`);
  }

  /**
   * Get recent messages for a chat.
   * @param {string} chatId
   * @returns {Array<{role: string, text: string, ts: string}>}
   */
  getRecent(chatId) {
    const filePath = this._filePath(chatId);
    if (!fs.existsSync(filePath)) return [];

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }

    // Return last N messages
    return messages.slice(-this.maxMessages);
  }

  /**
   * Append a message to chat history.
   * @param {string} chatId
   * @param {string} role - 'user' or 'assistant'
   * @param {string} text
   */
  append(chatId, role, text) {
    const filePath = this._filePath(chatId);
    const entry = {
      role,
      text: text.slice(0, 2000), // Truncate long messages
      ts: new Date().toISOString(),
    };

    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');

    // Trim if file gets too large (keep last maxMessages * 2 to avoid frequent trims)
    this._trimIfNeeded(filePath);
  }

  /**
   * Get the last assistant message for a chat.
   * @param {string} chatId
   * @returns {string|null}
   */
  getLastAssistantMessage(chatId) {
    const messages = this.getRecent(chatId);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].text;
    }
    return null;
  }

  _trimIfNeeded(filePath) {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const limit = this.maxMessages * 2;
    if (lines.length > limit) {
      const trimmed = lines.slice(-this.maxMessages);
      fs.writeFileSync(filePath, trimmed.join('\n') + '\n');
    }
  }
}

module.exports = { ChatHistory };
