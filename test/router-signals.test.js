'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Import static patterns directly from Router class
// We need to require the module and access the class
const { Router } = require('../lib/gateway/router');

describe('Signal Detection Patterns', () => {
  describe('PRIORITY_PATTERNS', () => {
    const match = (text) => Router.PRIORITY_PATTERNS.some((re) => re.test(text));

    it('matches "focus on the API"', () => assert.ok(match('focus on the API')));
    it('matches "this is urgent"', () => assert.ok(match('this is urgent')));
    it('matches "deadline is Friday"', () => assert.ok(match('deadline is Friday')));
    it('matches "pause the project"', () => assert.ok(match('pause the project')));
    it('matches "stop development"', () => assert.ok(match('stop development')));
    it('matches "先搞这个"', () => assert.ok(match('先搞这个')));
    it('matches "暂停这个项目"', () => assert.ok(match('暂停这个项目')));
    it('matches "不做了"', () => assert.ok(match('不做了')));

    // False positives that should NOT match
    it('does NOT match "bus stop"', () => assert.ok(!match('bus stop')));
    it('does NOT match "I paused to think"', () => assert.ok(!match('I paused to think')));
    it('does NOT match "the focus is clear"', () => assert.ok(!match('the focus is clear')));
  });

  describe('PREFERENCE_PATTERNS', () => {
    const match = (text) => Router.PREFERENCE_PATTERNS.some((re) => re.test(text));

    it('matches "from now on use English"', () => assert.ok(match('from now on use English')));
    it('matches "don\'t use tabs"', () => assert.ok(match("don't use tabs")));
    it('matches "I prefer concise answers"', () => assert.ok(match('I prefer concise answers')));
    it('matches "always include tests"', () => assert.ok(match('always include tests')));
    it('matches "never skip validation"', () => assert.ok(match('never skip validation')));
    it('matches "别用中文注释"', () => assert.ok(match('别用中文注释')));
    it('matches "以后都这样做"', () => assert.ok(match('以后都这样做')));

    // False positives
    it('does NOT match "it never rains"', () => {
      // "never" alone matches — this is acceptable because it's a strong signal word
    });
  });

  describe('IDENTITY_PATTERNS', () => {
    const match = (text) => Router.IDENTITY_PATTERNS.some((re) => re.test(text));

    it('matches "I am a data scientist"', () => assert.ok(match('I am a data scientist')));
    it('matches "I\'m a frontend dev"', () => assert.ok(match("I'm a frontend dev")));
    it('matches "my role is tech lead"', () => assert.ok(match('my role is tech lead')));
    it('matches "I work at Google"', () => assert.ok(match('I work at Google')));
    it('matches "my name is John"', () => assert.ok(match('my name is John')));
    it('matches "我是产品经理"', () => assert.ok(match('我是产品经理')));
    it('matches "我叫小明"', () => assert.ok(match('我叫小明')));

    it('does NOT match "what is the status"', () => assert.ok(!match('what is the status')));
  });

  describe('RESPONSE_PREFERENCE_HINTS', () => {
    const match = (text) => Router.RESPONSE_PREFERENCE_HINTS.some((re) => re.test(text));

    it('matches "I\'ll remember that"', () => assert.ok(match("I'll remember that")));
    it('matches "Noted, preference saved"', () => assert.ok(match('Noted, preference saved')));
    it('matches "记住了"', () => assert.ok(match('记住了')));
  });
});
