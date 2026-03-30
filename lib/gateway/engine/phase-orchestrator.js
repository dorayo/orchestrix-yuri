'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const tmx = require('./tmux-utils');
const { log } = require('../log');

const YURI_GLOBAL = path.join(os.homedir(), '.yuri');
const SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'yuri');

// ── Plan Agent Sequence ────────────────────────────────────────────────────────

const PLAN_AGENTS = [
  { name: 'analyst', cmd: '*create-doc project-brief', output: 'docs/project-brief.md', window: 0 },
  { name: 'pm', cmd: '*create-doc prd', output: 'docs/prd.md', window: 1 },
  { name: 'ux-expert', cmd: '*create-doc front-end-spec', output: 'docs/front-end-spec.md', window: 2 },
  { name: 'architect', cmd: '*create-doc fullstack-architecture', output: 'docs/architecture.md', window: 3 },
  { name: 'po', cmd: '*execute-checklist po-master-validation', output: null, window: 4 },
  { name: 'po', cmd: '*shard', output: null, window: 4, sameWindow: true },
];

// ── Orchestrator ───────────────────────────────────────────────────────────────

class PhaseOrchestrator {
  /**
   * @param {object} opts
   * @param {function} opts.onProgress - (message: string) → void — proactive Telegram notification
   * @param {function} opts.onComplete - (phase: string, summary: string) → void
   * @param {function} opts.onError - (phase: string, error: string) → void
   * @param {object} opts.config - engine config from channels.yaml
   */
  constructor(opts = {}) {
    this.onProgress = opts.onProgress || (() => {});
    this.onComplete = opts.onComplete || (() => {});
    this.onError = opts.onError || (() => {});
    this.config = opts.config || {};

    this._phase = null;       // 'plan' | 'develop' | null
    this._step = 0;           // current agent index
    this._session = null;     // tmux session name
    this._projectRoot = null;
    this._timer = null;
    this._lastHash = '';
    this._stableCount = 0;
  }

  isRunning() { return this._phase !== null; }

  getStatus() {
    if (!this._phase) {
      return { phase: null, message: 'No phase is running.' };
    }

    if (this._phase === 'plan') {
      const agent = PLAN_AGENTS[this._step];
      return {
        phase: 'plan',
        step: this._step + 1,
        total: PLAN_AGENTS.length,
        agent: agent ? agent.name : 'unknown',
        message: `📋 Planning: agent ${this._step + 1}/${PLAN_AGENTS.length} (${agent ? agent.name : '?'}) running`,
      };
    }

    if (this._phase === 'develop') {
      return {
        phase: 'develop',
        message: '💻 Development in progress. Agents running autonomously.',
      };
    }

    return { phase: this._phase, message: `Phase ${this._phase} is running.` };
  }

  cancel() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    const phase = this._phase;
    this._phase = null;
    this._step = 0;
    log.engine(`Phase ${phase} cancelled`);
  }

  // ── Plan Phase ─────────────────────────────────────────────────────────────

  /**
   * Start plan phase in background. Returns immediately with status message.
   */
  startPlan(projectRoot) {
    if (this._phase) {
      return `⚠️ Phase "${this._phase}" is already running. Use *status to check progress.`;
    }

    this._projectRoot = projectRoot;
    this._phase = 'plan';
    this._step = 0;
    this._lastHash = '';
    this._stableCount = 0;

    // Validate phase1 complete
    const phase1Path = path.join(projectRoot, '.yuri', 'state', 'phase1.yaml');
    if (fs.existsSync(phase1Path)) {
      const phase1 = yaml.load(fs.readFileSync(phase1Path, 'utf8')) || {};
      if (phase1.status !== 'complete') {
        this._phase = null;
        return '❌ Phase 1 (Create) is not complete. Run *create first.';
      }
    }

    // Check for resume — find last completed step
    const phase2Path = path.join(projectRoot, '.yuri', 'state', 'phase2.yaml');
    if (fs.existsSync(phase2Path)) {
      const phase2 = yaml.load(fs.readFileSync(phase2Path, 'utf8')) || {};
      if (phase2.status === 'complete') {
        this._phase = null;
        return '✅ Planning already complete. Run *develop to start development.';
      }
      if (phase2.status === 'in_progress' && Array.isArray(phase2.steps)) {
        const lastComplete = phase2.steps.findLastIndex((s) => s.status === 'complete');
        if (lastComplete >= 0) {
          this._step = lastComplete + 1;
          log.engine(`Resuming plan from step ${this._step + 1}/${PLAN_AGENTS.length}`);
        }
      }
    }

    // Create/ensure tmux session
    try {
      this._session = this._ensurePlanSession(projectRoot);
    } catch (err) {
      this._phase = null;
      return `❌ Failed to create planning session: ${err.message}`;
    }

    // Update memory
    this._updatePlanMemory('in_progress');

    // Start first (or resumed) agent
    try {
      this._startPlanAgent(this._step);
    } catch (err) {
      this._phase = null;
      return `❌ Failed to start agent: ${err.message}`;
    }

    // Start polling
    const pollInterval = this.config.phase_poll_interval || 30000;
    this._timer = setInterval(() => this._pollPlanAgent(), pollInterval);

    const agent = PLAN_AGENTS[this._step];
    return `🚀 Planning started! Agent ${this._step + 1}/${PLAN_AGENTS.length} (${agent.name}) is running.\n\nI'll notify you as each agent completes. You can ask me anything in the meantime.`;
  }

  /**
   * Poll current plan agent for completion.
   */
  _pollPlanAgent() {
    if (this._phase !== 'plan') return;

    const agent = PLAN_AGENTS[this._step];
    if (!agent) {
      this._completePlan();
      return;
    }

    // Check if tmux session is alive
    if (!tmx.hasSession(this._session)) {
      this._handleError('plan', 'tmux session died unexpectedly');
      return;
    }

    // Check completion
    const result = tmx.checkCompletion(this._session, agent.window, this._lastHash);

    if (result.status === 'complete') {
      this._onAgentComplete(agent);
      return;
    }

    if (result.status === 'stable') {
      this._stableCount++;
      this._lastHash = result.hash;
      if (this._stableCount >= 3) {
        // Content stable for 3 polls — agent likely done
        this._onAgentComplete(agent);
        return;
      }
    } else {
      this._stableCount = 0;
      this._lastHash = result.hash || '';
    }
  }

  _onAgentComplete(agent) {
    this._stableCount = 0;
    this._lastHash = '';

    // Verify output file if specified
    let outputExists = true;
    if (agent.output) {
      const outputPath = path.join(this._projectRoot, agent.output);
      outputExists = fs.existsSync(outputPath);
    }

    // Update phase2 memory
    this._updatePlanStepMemory(this._step, 'complete', agent.output);

    const stepNum = this._step + 1;
    log.engine(`Plan agent ${stepNum}/${PLAN_AGENTS.length} (${agent.name}) complete`);

    // Notify user
    const outputStatus = agent.output ? (outputExists ? `→ ${agent.output}` : `⚠️ ${agent.output} not found`) : '';
    this.onProgress(`✅ Agent ${stepNum}/${PLAN_AGENTS.length} (${agent.name}) complete ${outputStatus}`);

    // Move to next agent
    this._step++;

    if (this._step >= PLAN_AGENTS.length) {
      this._completePlan();
      return;
    }

    // Start next agent
    try {
      this._startPlanAgent(this._step);
    } catch (err) {
      this._handleError('plan', `Failed to start next agent: ${err.message}`);
    }
  }

  _completePlan() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    // Kill planning session
    if (this._session && tmx.hasSession(this._session)) {
      tmx.killSession(this._session);
    }

    // Update memory
    this._updatePlanMemory('complete');

    this._phase = null;
    this._step = 0;

    log.engine('Plan phase complete');
    this.onComplete('plan', '🎉 Planning phase complete! All 6 agents finished.\n\nRun *develop to start automated development.');
  }

  _startPlanAgent(stepIdx) {
    const agent = PLAN_AGENTS[stepIdx];
    if (!agent) return;

    log.engine(`Starting plan agent ${stepIdx + 1}/${PLAN_AGENTS.length}: ${agent.name} → ${agent.cmd}`);

    // Create new window unless sameWindow
    if (!agent.sameWindow && stepIdx > 0) {
      tmx.newWindow(this._session, agent.window, agent.name, this._projectRoot);
      // Start Claude Code in the new window
      tmx.sendKeys(this._session, agent.window, 'cc');
      execSync('sleep 1');
      execSync(`tmux send-keys -t "${this._session}:${agent.window}" C-m`);

      // Wait for Claude Code to start (with trust dialog handling)
      const ready = tmx.waitForPrompt(this._session, agent.window, 30000);
      if (!ready) {
        throw new Error(`Claude Code did not start in window ${agent.window}`);
      }
    }

    // Activate Orchestrix agent
    tmx.sendKeysWithEnter(this._session, agent.window, `/o ${agent.name}`);
    execSync('sleep 10'); // Wait for agent to load

    // Send command
    tmx.sendKeysWithEnter(this._session, agent.window, agent.cmd);
  }

  _ensurePlanSession(projectRoot) {
    const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`ensure-session.sh not found at ${scriptPath}`);
    }

    const result = execSync(`bash "${scriptPath}" planning "${projectRoot}"`, {
      encoding: 'utf8',
      timeout: 60000,
    }).trim();

    // ensure-session.sh echoes the session name
    const lines = result.split('\n');
    return lines[lines.length - 1].trim();
  }

  // ── Develop Phase ──────────────────────────────────────────────────────────

  startDevelop(projectRoot) {
    if (this._phase) {
      return `⚠️ Phase "${this._phase}" is already running. Use *status to check progress.`;
    }

    this._projectRoot = projectRoot;
    this._phase = 'develop';

    // Validate phase2 complete
    const phase2Path = path.join(projectRoot, '.yuri', 'state', 'phase2.yaml');
    if (fs.existsSync(phase2Path)) {
      const phase2 = yaml.load(fs.readFileSync(phase2Path, 'utf8')) || {};
      if (phase2.status !== 'complete') {
        this._phase = null;
        return '❌ Phase 2 (Plan) is not complete. Run *plan first.';
      }
    }

    // Start dev session via ensure-session.sh (runs start-orchestrix.sh)
    try {
      const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
      const result = execSync(`bash "${scriptPath}" dev "${projectRoot}"`, {
        encoding: 'utf8',
        timeout: 120000, // dev session setup takes longer (start-orchestrix.sh)
      }).trim();
      const lines = result.split('\n');
      this._session = lines[lines.length - 1].trim();
    } catch (err) {
      this._phase = null;
      return `❌ Failed to start dev session: ${err.message}`;
    }

    // Start polling (less frequent — handoff-detector handles agent chaining)
    const pollInterval = this.config.dev_poll_interval || 300000; // 5 min
    this._timer = setInterval(() => this._pollDevSession(), pollInterval);

    log.engine(`Dev phase started: session=${this._session}`);
    return '🚀 Development started! 4 agents (Architect, SM, Dev, QA) are running.\n\nAgents chain automatically via handoff-detector. I\'ll report progress every 5 minutes.';
  }

  _pollDevSession() {
    if (this._phase !== 'develop') return;

    if (!tmx.hasSession(this._session)) {
      this._handleError('develop', 'Dev tmux session died unexpectedly');
      return;
    }

    // Read story progress from scan-stories.sh or phase3.yaml
    const phase3Path = path.join(this._projectRoot, '.yuri', 'state', 'phase3.yaml');
    if (fs.existsSync(phase3Path)) {
      try {
        const phase3 = yaml.load(fs.readFileSync(phase3Path, 'utf8')) || {};
        const progress = phase3.progress || {};
        const byStatus = progress.by_status || {};
        const total = progress.total_stories || 0;
        const done = (byStatus.done || 0) + (byStatus.complete || 0);

        if (total > 0 && done >= total) {
          this._completeDev();
          return;
        }

        // Report progress
        this.onProgress(`💻 Dev progress: ${done}/${total} stories complete`);
      } catch { /* continue polling */ }
    }
  }

  _completeDev() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._phase = null;
    log.engine('Dev phase complete');
    this.onComplete('develop', '🎉 Development complete! All stories finished.\n\nRun *test to start smoke testing.');
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  _handleError(phase, message) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._phase = null;
    log.error(`Phase ${phase} error: ${message}`);
    this.onError(phase, message);
  }

  _updatePlanMemory(status) {
    const projectRoot = this._projectRoot;
    const yuriDir = path.join(projectRoot, '.yuri');

    // Update phase2.yaml
    const phase2Path = path.join(yuriDir, 'state', 'phase2.yaml');
    const stateDir = path.join(yuriDir, 'state');
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

    let phase2 = {};
    if (fs.existsSync(phase2Path)) {
      phase2 = yaml.load(fs.readFileSync(phase2Path, 'utf8')) || {};
    }

    phase2.status = status;
    if (status === 'in_progress' && !phase2.started_at) {
      phase2.started_at = new Date().toISOString();
    }
    if (status === 'complete') {
      phase2.completed_at = new Date().toISOString();
    }
    if (!Array.isArray(phase2.steps)) {
      phase2.steps = PLAN_AGENTS.map((a) => ({ id: a.name, status: 'pending' }));
    }
    if (this._session) {
      phase2.tmux = { session: this._session };
    }

    fs.writeFileSync(phase2Path, yaml.dump(phase2, { lineWidth: -1 }));

    // Update focus.yaml
    const focusPath = path.join(yuriDir, 'focus.yaml');
    let focus = {};
    if (fs.existsSync(focusPath)) {
      focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
    }
    focus.phase = 2;
    focus.step = status === 'complete' ? 'phase2.complete' : 'planning';
    focus.pulse = status === 'complete' ? 'Phase 2 complete' : `Phase 2: ${this._step + 1}/${PLAN_AGENTS.length} agents`;
    focus.updated_at = new Date().toISOString();
    fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
  }

  _updatePlanStepMemory(stepIdx, status, output) {
    const phase2Path = path.join(this._projectRoot, '.yuri', 'state', 'phase2.yaml');
    if (!fs.existsSync(phase2Path)) return;

    const phase2 = yaml.load(fs.readFileSync(phase2Path, 'utf8')) || {};
    if (Array.isArray(phase2.steps) && phase2.steps[stepIdx]) {
      phase2.steps[stepIdx].status = status;
      if (output) phase2.steps[stepIdx].output = output;
      phase2.steps[stepIdx].completed_at = new Date().toISOString();
    }

    fs.writeFileSync(phase2Path, yaml.dump(phase2, { lineWidth: -1 }));

    // Append timeline event
    const timelinePath = path.join(this._projectRoot, '.yuri', 'timeline', 'events.jsonl');
    const timelineDir = path.dirname(timelinePath);
    if (!fs.existsSync(timelineDir)) fs.mkdirSync(timelineDir, { recursive: true });

    const event = {
      ts: new Date().toISOString(),
      type: 'agent_completed',
      agent: PLAN_AGENTS[stepIdx].name,
      output: output || '',
    };
    fs.appendFileSync(timelinePath, JSON.stringify(event) + '\n');
  }

  /**
   * Graceful shutdown — stop polling but don't kill tmux sessions.
   */
  shutdown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    log.engine('Phase orchestrator shut down (tmux sessions preserved)');
  }
}

module.exports = { PhaseOrchestrator };
