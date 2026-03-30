'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { isEmptyTemplate } = require('../lib/gateway/engine/claude-sdk');

describe('isEmptyTemplate', () => {
  it('returns true for empty string', () => {
    assert.ok(isEmptyTemplate(''));
  });

  it('returns true for null/undefined YAML', () => {
    assert.ok(isEmptyTemplate('---'));
    assert.ok(isEmptyTemplate('# just a comment'));
  });

  it('returns true for all-empty fields', () => {
    assert.ok(isEmptyTemplate(`
name: ""
role: ""
expertise:
  strong: []
  growing: []
work_style:
  hours: ""
  decision_speed: ""
    `));
  });

  it('returns false when name has a value', () => {
    assert.ok(!isEmptyTemplate(`
name: Yuri
role: ""
    `));
  });

  it('returns false when array has items', () => {
    assert.ok(!isEmptyTemplate(`
name: ""
capabilities:
  - project management
    `));
  });

  it('returns false for observed array with entries', () => {
    assert.ok(!isEmptyTemplate(`
name: ""
observed:
  - ts: "2026-03-30"
    signal: boss_preference
    raw: "use English"
    `));
  });

  it('returns true for deeply nested empty values', () => {
    assert.ok(isEmptyTemplate(`
a:
  b:
    c: ""
    d: []
  e: null
    `));
  });

  it('returns false for numeric values', () => {
    assert.ok(!isEmptyTemplate(`
version: 2.0
name: ""
    `));
  });

  it('returns false for boolean values', () => {
    assert.ok(!isEmptyTemplate(`
active: true
name: ""
    `));
  });
});
