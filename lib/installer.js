'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_SOURCE = path.join(__dirname, '..', 'skill');
const SKILL_TARGET = path.join(os.homedir(), '.claude', 'skills', 'yuri');
const YURI_GLOBAL = path.join(os.homedir(), '.yuri');
const TEMPLATES_DIR = path.join(SKILL_SOURCE, 'templates');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function makeScriptsExecutable(dir) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      makeScriptsExecutable(fullPath);
    } else if (entry.name.endsWith('.sh')) {
      fs.chmodSync(fullPath, 0o755);
    }
  }
}

function install() {
  console.log('');
  console.log('  Installing Yuri Meta-Orchestrator...');
  console.log('');

  // Check source exists
  if (!fs.existsSync(SKILL_SOURCE)) {
    console.error('  Error: Skill source directory not found.');
    console.error(`  Expected: ${SKILL_SOURCE}`);
    process.exit(1);
  }

  // Check for existing installation
  if (fs.existsSync(SKILL_TARGET)) {
    console.log(`  Existing installation found at ${SKILL_TARGET}`);
    console.log('  Overwriting...');
    fs.rmSync(SKILL_TARGET, { recursive: true, force: true });
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(SKILL_TARGET);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Copy skill directory
  copyDirRecursive(SKILL_SOURCE, SKILL_TARGET);

  // Make all .sh files executable
  makeScriptsExecutable(path.join(SKILL_TARGET, 'scripts'));
  makeScriptsExecutable(path.join(SKILL_TARGET, 'resources'));

  // Initialize global memory (~/.yuri/)
  initGlobalMemory();

  console.log('  Skill location: ~/.claude/skills/yuri/');
  console.log('  Global memory:  ~/.yuri/');
  console.log('');
  console.log('  Usage: Type /yuri in any Claude Code session to activate.');
  console.log('');
  console.log('  Yuri will:');
  console.log('  1. Manage your project portfolio as your Technical Chief of Staff');
  console.log('  2. Create project skeletons with Orchestrix infrastructure');
  console.log('  3. Drive planning, development, testing, and deployment automatically');
  console.log('  4. Accumulate knowledge and wisdom across projects over time');
  console.log('');
}

function initGlobalMemory() {
  console.log('  Initializing Yuri global memory at ~/.yuri/...');

  // Directory structure
  const dirs = [
    YURI_GLOBAL,
    path.join(YURI_GLOBAL, 'boss'),
    path.join(YURI_GLOBAL, 'portfolio'),
    path.join(YURI_GLOBAL, 'wisdom'),
    path.join(YURI_GLOBAL, 'config'),
    path.join(YURI_GLOBAL, 'chat-history'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Template-based files: only create if not already present (protect accumulated memory)
  const templateMappings = [
    ['self.template.yaml',                    path.join(YURI_GLOBAL, 'self.yaml')],
    ['boss-profile.template.yaml',            path.join(YURI_GLOBAL, 'boss', 'profile.yaml')],
    ['boss-preferences.template.yaml',        path.join(YURI_GLOBAL, 'boss', 'preferences.yaml')],
    ['portfolio-registry.template.yaml',      path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml')],
    ['portfolio-priorities.template.yaml',    path.join(YURI_GLOBAL, 'portfolio', 'priorities.yaml')],
    ['portfolio-relationships.template.yaml', path.join(YURI_GLOBAL, 'portfolio', 'relationships.yaml')],
    ['global-focus.template.yaml',            path.join(YURI_GLOBAL, 'focus.yaml')],
    ['channels.template.yaml',               path.join(YURI_GLOBAL, 'config', 'channels.yaml')],
  ];

  for (const [template, target] of templateMappings) {
    if (!fs.existsSync(target)) {
      const src = path.join(TEMPLATES_DIR, template);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, target);
      }
    }
  }

  // Inbox file: create if not present, add bootstrap signal for first interaction
  const inboxPath = path.join(YURI_GLOBAL, 'inbox.jsonl');
  if (!fs.existsSync(inboxPath)) {
    const bootstrap = JSON.stringify({
      ts: new Date().toISOString(),
      signal: 'boss_identity',
      raw: '(bootstrap) User just installed Yuri. On first interaction, greet them warmly as Yuri and ask for their name and role so you can personalize the experience.',
      context: 'installer',
      processed: false,
    });
    fs.writeFileSync(inboxPath, bootstrap + '\n');
  }

  // Wisdom files: create with header comment if not present
  const wisdomFiles = [
    [path.join(YURI_GLOBAL, 'wisdom', 'tech.md'),     "# Yuri's Technical Wisdom\n"],
    [path.join(YURI_GLOBAL, 'wisdom', 'workflow.md'),  "# Yuri's Workflow Wisdom\n"],
    [path.join(YURI_GLOBAL, 'wisdom', 'pitfalls.md'),  "# Yuri's Pitfall Records\n"],
    [path.join(YURI_GLOBAL, 'wisdom', 'archive.md'),   "# Archived Wisdom (decayed entries)\n"],
  ];

  for (const [filePath, header] of wisdomFiles) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, header);
    }
  }

  console.log('  Global memory initialized (existing files preserved).');
}

module.exports = { install };
