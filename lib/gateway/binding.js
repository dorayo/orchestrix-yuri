'use strict';

const { loadConfig, saveConfig } = require('./config');

/**
 * Owner binding manager.
 * In single-user self-deploy mode, the first person to message the bot becomes the owner.
 * Subsequent messages from unknown chat_ids are rejected.
 */
class OwnerBinding {
  /**
   * @param {object} opts
   * @param {string} opts.channelType - 'telegram' or 'feishu'
   */
  constructor(opts) {
    this.channelType = opts.channelType;
  }

  /**
   * Check if a chat_id is the authorized owner.
   * If no owner is set yet, auto-bind this chat_id as owner.
   *
   * @param {string} chatId
   * @returns {{allowed: boolean, firstBind: boolean}}
   */
  check(chatId) {
    const config = loadConfig();
    const channel = config.channels[this.channelType];

    if (!channel) {
      return { allowed: false, firstBind: false };
    }

    const ownerField = this.channelType === 'telegram' ? 'owner_chat_id' : 'owner_user_id';
    const currentOwner = channel[ownerField];

    // No owner set yet — auto-bind
    if (!currentOwner) {
      channel[ownerField] = String(chatId);
      saveConfig(config);
      console.log(`[binding] Auto-bound ${this.channelType} owner: ${chatId}`);
      return { allowed: true, firstBind: true };
    }

    // Check if this is the owner
    if (String(currentOwner) === String(chatId)) {
      return { allowed: true, firstBind: false };
    }

    // Not the owner
    console.log(`[binding] Rejected message from non-owner: ${chatId} (owner: ${currentOwner})`);
    return { allowed: false, firstBind: false };
  }
}

module.exports = { OwnerBinding };
