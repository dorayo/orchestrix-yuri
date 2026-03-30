'use strict';

// ── ANSI Color Helpers ─────────────────────────────────────────────────────────
// No dependencies — raw escape codes for terminal coloring.

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgBlue:  '\x1b[44m',
};

const tag = (color, label) => `${color}${c.bold}[${label}]${c.reset}`;

const log = {
  // Tagged module loggers
  gateway: (msg) => console.log(`${tag(c.magenta, 'gateway')} ${msg}`),
  router:  (msg) => console.log(`${tag(c.blue, 'router')} ${msg}`),
  tmux:    (msg) => console.log(`${tag(c.cyan, 'tmux')} ${msg}`),
  telegram:(msg) => console.log(`${tag(c.green, 'telegram')} ${msg}`),

  // Levels
  ok:    (msg) => console.log(`  ${c.green}✅ ${msg}${c.reset}`),
  warn:  (msg) => console.warn(`  ${c.yellow}⚠️  ${msg}${c.reset}`),
  error: (msg) => console.error(`  ${c.red}❌ ${msg}${c.reset}`),
  info:  (msg) => console.log(`  ${c.dim}${msg}${c.reset}`),

  // Banner
  banner: (msg) => console.log(`\n  ${c.bold}${c.magenta}${msg}${c.reset}\n`),
};

module.exports = { log, c };
