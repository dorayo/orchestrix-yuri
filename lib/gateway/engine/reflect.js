'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { log } = require('../log');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');
const INBOX_PATH = path.join(YURI_GLOBAL, 'inbox.jsonl');

// Signal → target file mapping (mirrors observe-signals.yaml)
const SIGNAL_TARGETS = {
  boss_preference:  path.join(YURI_GLOBAL, 'boss', 'preferences.yaml'),
  boss_identity:    path.join(YURI_GLOBAL, 'boss', 'profile.yaml'),
  priority_change:  path.join(YURI_GLOBAL, 'portfolio', 'priorities.yaml'),
  // tech_lesson and correction are project-specific, handled separately
  // emotion stays in inbox for context
};

const MAX_INBOX_LINES = 100;
const KEEP_INBOX_LINES = 50;

/**
 * Reflect Engine (F.1) — Process unprocessed inbox signals.
 *
 * Reads inbox.jsonl, groups entries by signal type, appends raw observations
 * to target YAML files under an `observed:` array. Claude interprets these
 * observations contextually on the next system prompt load.
 *
 * @returns {number} Number of entries processed
 */
function runReflect() {
  if (!fs.existsSync(INBOX_PATH)) return 0;

  const raw = fs.readFileSync(INBOX_PATH, 'utf8').trim();
  if (!raw) return 0;

  // Parse all entries
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Filter unprocessed
  const unprocessed = entries.filter((e) => !e.processed);
  if (unprocessed.length === 0) return 0;

  // Group by signal type
  const groups = {};
  for (const entry of unprocessed) {
    const sig = entry.signal || 'unknown';
    if (!groups[sig]) groups[sig] = [];
    groups[sig].push(entry);
  }

  // Process each group
  let processedCount = 0;

  for (const [signal, items] of Object.entries(groups)) {
    const targetPath = SIGNAL_TARGETS[signal];
    if (!targetPath) {
      // No target file for this signal type (e.g., emotion, correction)
      // Just mark as processed
      for (const item of items) item.processed = true;
      processedCount += items.length;
      continue;
    }

    try {
      appendObservations(targetPath, signal, items);
      for (const item of items) item.processed = true;
      processedCount += items.length;
    } catch (err) {
      log.warn(`Reflect: failed to write ${signal} to ${targetPath}: ${err.message}`);
    }
  }

  if (processedCount > 0) {
    log.engine(`Reflect: processed ${processedCount} inbox signals`);
  }

  // Rewrite inbox with processed markers (atomic write)
  rewriteInbox(entries);

  return processedCount;
}

/**
 * Append raw observations to a target YAML file's `observed:` array.
 * Preserves existing content and structured fields.
 */
function appendObservations(targetPath, signal, items) {
  let doc = {};

  if (fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, 'utf8');
    doc = yaml.load(content) || {};
  }

  // Initialize observed array if missing
  if (!Array.isArray(doc.observed)) {
    doc.observed = [];
  }

  // Append new observations
  for (const item of items) {
    doc.observed.push({
      ts: item.ts,
      signal,
      raw: item.raw,
      context: item.context || '',
    });
  }

  // Keep only last 30 observations to prevent unbounded growth
  if (doc.observed.length > 30) {
    doc.observed = doc.observed.slice(-30);
  }

  // Write atomically: temp file then rename
  const tmpPath = targetPath + '.tmp';
  const header = getFileHeader(signal);
  const yamlContent = yaml.dump(doc, { lineWidth: -1 });
  fs.writeFileSync(tmpPath, header + yamlContent);
  fs.renameSync(tmpPath, targetPath);
}

/**
 * Get the header comment for a target file (preserves documentation).
 */
function getFileHeader(signal) {
  switch (signal) {
    case 'boss_preference':
      return '# Boss Preferences — accumulated understanding of user preferences\n' +
             '# Location: ~/.yuri/boss/preferences.yaml\n\n';
    case 'boss_identity':
      return '# Boss Profile — accumulated understanding of the user\n' +
             '# Location: ~/.yuri/boss/profile.yaml\n\n';
    case 'priority_change':
      return '# Portfolio Priorities — project priority signals\n' +
             '# Location: ~/.yuri/portfolio/priorities.yaml\n\n';
    default:
      return '';
  }
}

/**
 * Atomically rewrite inbox.jsonl with updated entries.
 * Truncates if too many lines.
 */
function rewriteInbox(entries) {
  // Truncate: keep only recent entries if exceeding max
  let toWrite = entries;
  if (toWrite.length > MAX_INBOX_LINES) {
    toWrite = toWrite.slice(-KEEP_INBOX_LINES);
  }

  const content = toWrite.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const tmpPath = INBOX_PATH + '.tmp';
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, INBOX_PATH);
}

module.exports = { runReflect };
