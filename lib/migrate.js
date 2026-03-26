'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');

function migrate(projectRoot) {
  const yuriDir = path.join(projectRoot, '.yuri');
  const memoryFile = path.join(yuriDir, 'memory.yaml');

  if (!fs.existsSync(memoryFile)) {
    console.error(`  Error: No memory.yaml found at ${memoryFile}`);
    process.exit(1);
  }

  if (fs.existsSync(path.join(yuriDir, 'identity.yaml'))) {
    console.log('  Project already uses the new memory structure. Skipping.');
    return;
  }

  console.log('');
  console.log('  Migrating Yuri memory to four-layer structure...');
  console.log(`  Source: ${memoryFile}`);
  console.log('');

  const raw = fs.readFileSync(memoryFile, 'utf8');
  const mem = yaml.load(raw) || {};

  // Ensure directories
  const dirs = ['knowledge', 'state', 'timeline', 'checkpoints'];
  for (const dir of dirs) {
    const dirPath = path.join(yuriDir, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // 1. Extract identity.yaml
  const identity = {
    project: {
      name: (mem.project && mem.project.name) || '',
      root: (mem.project && mem.project.project_root) || projectRoot,
      stack: (mem.project && mem.project.tech_stack) || '',
      domain: '',
      description: (mem.project && mem.project.description) || '',
      created_at: (mem.project && mem.project.created_at) || '',
      license_key: (mem.project && mem.project.license_key) || '',
    },
  };
  writeYaml(path.join(yuriDir, 'identity.yaml'), identity, 'Project Identity (migrated from memory.yaml)');
  console.log('  ✓ identity.yaml');

  // 2. Extract focus.yaml
  const lifecycle = mem.lifecycle || {};
  const tmuxData = mem.tmux || {};
  const focus = {
    phase: lifecycle.current_phase || 0,
    step: lifecycle.current_step || '',
    action: '',
    blocked: false,
    pulse: `Migrated from legacy memory. Phase ${lifecycle.current_phase || 0}.`,
    updated_at: new Date().toISOString(),
    tmux: {
      planning_session: tmuxData.planning_session || '',
      dev_session: tmuxData.dev_session || '',
    },
  };
  writeYaml(path.join(yuriDir, 'focus.yaml'), focus, 'Project Focus (migrated from memory.yaml)');
  console.log('  ✓ focus.yaml');

  // 3. Extract phase state files
  const phaseStatus = (lifecycle.phase_status) || {};

  // Phase 1
  const phase1 = {
    status: phaseStatus.phase1_create || 'pending',
    created_at: (mem.project && mem.project.created_at) || '',
    completed_at: phaseStatus.phase1_create === 'complete' ? '' : '',
    collected: {
      name: (mem.project && mem.project.name) || '',
      dir_name: (mem.project && mem.project.dir_name) || '',
      license_key: (mem.project && mem.project.license_key) || '',
      description: (mem.project && mem.project.description) || '',
    },
  };
  writeYaml(path.join(yuriDir, 'state', 'phase1.yaml'), phase1, 'Phase 1 state (migrated)');

  // Phase 2
  if (mem.planning) {
    const phase2 = {
      status: phaseStatus.phase2_plan || 'pending',
      started_at: '',
      completed_at: '',
      steps: (mem.planning.steps || []).map((s) => ({
        id: s.id || '',
        status: s.status || 'pending',
        output: s.output || '',
        completed_at: s.completed_at || '',
      })),
      tmux: { session: tmuxData.planning_session || '' },
    };
    writeYaml(path.join(yuriDir, 'state', 'phase2.yaml'), phase2, 'Phase 2 state (migrated)');
  }

  // Phase 3
  if (mem.development) {
    const dev = mem.development;
    const phase3 = {
      status: phaseStatus.phase3_develop || 'pending',
      started_at: '',
      completed_at: '',
      progress: {
        total_epics: dev.total_epics || 0,
        total_stories: dev.total_stories || 0,
        by_status: {
          done: [],
          in_progress: dev.stories_in_progress || [],
          blocked: [],
          remaining: [],
        },
      },
      monitoring: {
        poll_count: 0,
        stuck_count: dev.stuck_count || 0,
        last_progress_at: dev.last_progress_at || '',
      },
      tmux: {
        session: tmuxData.dev_session || '',
        windows: { 0: 'architect', 1: 'sm', 2: 'dev', 3: 'qa' },
      },
    };
    writeYaml(path.join(yuriDir, 'state', 'phase3.yaml'), phase3, 'Phase 3 state (migrated)');
  }

  // Phase 4
  if (mem.testing) {
    const phase4 = {
      status: phaseStatus.phase4_test || 'pending',
      started_at: '',
      completed_at: '',
      epics: (mem.testing.epics || []).map((e) => ({
        id: e.id || '',
        status: e.status || 'pending',
        rounds: e.rounds || 0,
        last_tested_at: '',
      })),
      regression_rounds: 0,
    };
    writeYaml(path.join(yuriDir, 'state', 'phase4.yaml'), phase4, 'Phase 4 state (migrated)');
  }

  // Phase 5
  if (mem.deployment) {
    const phase5 = {
      status: phaseStatus.phase5_deploy || 'pending',
      started_at: '',
      completed_at: '',
      strategy: mem.deployment.strategy || '',
      url: mem.deployment.url || '',
      health: mem.deployment.status || '',
    };
    writeYaml(path.join(yuriDir, 'state', 'phase5.yaml'), phase5, 'Phase 5 state (migrated)');
  }

  console.log('  ✓ state/phase*.yaml');

  // 4. Convert changes.history to timeline events
  const eventsFile = path.join(yuriDir, 'timeline', 'events.jsonl');
  const events = [];

  // Add phase events from status
  if (phaseStatus.phase1_create === 'complete') {
    events.push({ ts: mem.project.created_at || '', type: 'phase_completed', phase: 1 });
  }
  if (phaseStatus.phase2_plan === 'complete') {
    events.push({ ts: '', type: 'phase_completed', phase: 2 });
  }
  if (phaseStatus.phase3_develop === 'complete') {
    events.push({ ts: '', type: 'phase_completed', phase: 3 });
  }
  if (phaseStatus.phase4_test === 'complete') {
    events.push({ ts: '', type: 'phase_completed', phase: 4 });
  }
  if (phaseStatus.phase5_deploy === 'complete') {
    events.push({ ts: '', type: 'phase_completed', phase: 5 });
  }

  // Convert change history
  if (mem.changes && mem.changes.history) {
    for (const change of mem.changes.history) {
      events.push({
        ts: change.timestamp || '',
        type: 'change_request',
        phase: change.phase || 0,
        scope: change.scope || '',
        desc: change.description || '',
        action: change.action_taken || '',
      });
    }
  }

  // Add migration event
  events.push({
    ts: new Date().toISOString(),
    type: 'memory_migrated',
    detail: 'Migrated from legacy memory.yaml to four-layer structure',
  });

  const eventsContent = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(eventsFile, eventsContent);
  console.log('  ✓ timeline/events.jsonl');

  // 5. Create knowledge placeholders
  const knowledgeFiles = [
    [path.join(yuriDir, 'knowledge', 'decisions.md'), '# Architecture Decisions\n'],
    [path.join(yuriDir, 'knowledge', 'domain.md'), '# Domain Knowledge\n'],
    [path.join(yuriDir, 'knowledge', 'insights.md'), '# Project Insights\n'],
  ];
  for (const [filePath, header] of knowledgeFiles) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, header);
    }
  }
  console.log('  ✓ knowledge/');

  // 6. Backup old memory.yaml
  const backupFile = memoryFile + '.backup';
  fs.renameSync(memoryFile, backupFile);
  console.log(`  ✓ memory.yaml → memory.yaml.backup`);

  // 7. Register in portfolio (if global memory exists)
  const registryFile = path.join(YURI_GLOBAL, 'portfolio', 'registry.yaml');
  if (fs.existsSync(registryFile)) {
    const registryRaw = fs.readFileSync(registryFile, 'utf8');
    const registry = yaml.load(registryRaw) || { projects: [] };
    if (!registry.projects) registry.projects = [];

    const dirName = (mem.project && mem.project.dir_name) || path.basename(projectRoot);
    const alreadyRegistered = registry.projects.some((p) => p.id === dirName);

    if (!alreadyRegistered) {
      registry.projects.push({
        id: dirName,
        name: (mem.project && mem.project.name) || dirName,
        root: projectRoot,
        phase: lifecycle.current_phase || 0,
        status: 'active',
        pulse: `Migrated. Phase ${lifecycle.current_phase || 0}.`,
        started_at: (mem.project && mem.project.created_at) || '',
      });
      fs.writeFileSync(registryFile, yaml.dump(registry, { lineWidth: -1 }));
      console.log('  ✓ Registered in ~/.yuri/portfolio/registry.yaml');
    }
  }

  console.log('');
  console.log('  Migration complete!');
  console.log('');
}

function writeYaml(filePath, data, comment) {
  const header = `# ${comment}\n\n`;
  const content = header + yaml.dump(data, { lineWidth: -1 });
  fs.writeFileSync(filePath, content);
}

// CLI entry point
if (require.main === module) {
  const projectRoot = process.argv[2] || process.cwd();
  const resolvedRoot = path.resolve(projectRoot);

  if (!fs.existsSync(resolvedRoot)) {
    console.error(`  Error: Directory not found: ${resolvedRoot}`);
    process.exit(1);
  }

  migrate(resolvedRoot);
}

module.exports = { migrate };
