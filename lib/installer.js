'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SKILL_SOURCE = path.join(__dirname, '..', 'skill');
const SKILL_TARGET = path.join(os.homedir(), '.claude', 'skills', 'yuri');

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

  console.log('  Skill location: ~/.claude/skills/yuri/');
  console.log('');
  console.log('  Usage: Type /yuri in any Claude Code session to activate.');
  console.log('');
  console.log('  Yuri will:');
  console.log('  1. Collect your project idea');
  console.log('  2. Create a project skeleton with Orchestrix infrastructure');
  console.log('  3. Drive planning, development, testing, and deployment automatically');
  console.log('');
}

module.exports = { install };
