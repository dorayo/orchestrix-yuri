'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ChatHistory } = require('../lib/gateway/history');

describe('ChatHistory', () => {
  const tmpDir = path.join(os.tmpdir(), `yuri-history-test-${Date.now()}`);
  let history;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    history = new ChatHistory({ storageDir: tmpDir, maxMessages: 5 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends and retrieves messages', () => {
    history.append('chat1', 'user', 'hello');
    history.append('chat1', 'assistant', 'hi there');

    const recent = history.getRecent('chat1');
    assert.equal(recent.length, 2);
    assert.equal(recent[0].role, 'user');
    assert.equal(recent[0].text, 'hello');
    assert.equal(recent[1].role, 'assistant');
    assert.equal(recent[1].text, 'hi there');
  });

  it('returns empty array for unknown chatId', () => {
    const recent = history.getRecent('nonexistent');
    assert.deepEqual(recent, []);
  });

  it('isolates different chatIds', () => {
    history.append('chat1', 'user', 'msg1');
    history.append('chat2', 'user', 'msg2');

    assert.equal(history.getRecent('chat1').length, 1);
    assert.equal(history.getRecent('chat2').length, 1);
    assert.equal(history.getRecent('chat1')[0].text, 'msg1');
    assert.equal(history.getRecent('chat2')[0].text, 'msg2');
  });

  it('respects maxMessages limit', () => {
    for (let i = 0; i < 10; i++) {
      history.append('chat1', 'user', `msg${i}`);
    }

    const recent = history.getRecent('chat1');
    assert.ok(recent.length <= 5);
  });
});
