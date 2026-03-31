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

    // Agent question bridging
    this._waitingForInput = false;     // true when agent asked a question
    this._waitingMessageId = null;     // Telegram message_id of the question notification
    this._onQuestionAsked = opts.onQuestionAsked || (() => Promise.resolve(null));

    // Dev phase progress reporting
    this._devStartedAt = null;         // timestamp when dev phase started
    this._lastReportTime = 0;          // last progress report timestamp
    this._reportInterval = (opts.config && opts.config.report_interval) || 1800000; // 30 min default
    // onQuestionAsked(text) → sends to Telegram, returns { messageId }
  }

  isRunning() { return this._phase !== null; }
  isWaitingForInput() { return this._waitingForInput; }

  /**
   * Try to recover an in-progress phase from YAML state + tmux session.
   * Called once on gateway startup. If a phase was running when the gateway
   * died, reconnect to the existing tmux session and resume polling.
   */
  tryRecover(projectRoot) {
    if (this._phase) return; // already running
    if (!projectRoot) return;

    // Check phase2 (plan)
    const phase2Path = path.join(projectRoot, '.yuri', 'state', 'phase2.yaml');
    if (fs.existsSync(phase2Path)) {
      const phase2 = yaml.load(fs.readFileSync(phase2Path, 'utf8')) || {};
      if (phase2.status === 'in_progress' && phase2.tmux && phase2.tmux.session) {
        if (tmx.hasSession(phase2.tmux.session)) {
          // Recover: reconnect to existing session, resume polling
          this._phase = 'plan';
          this._projectRoot = projectRoot;
          this._session = phase2.tmux.session;

          // Find current step from YAML
          if (Array.isArray(phase2.steps)) {
            const lastComplete = phase2.steps.findLastIndex((s) => s.status === 'complete');
            this._step = lastComplete >= 0 ? lastComplete + 1 : 0;
          }

          const pollInterval = this.config.phase_poll_interval || 30000;
          this._timer = setInterval(() => this._pollPlanAgent(), pollInterval);

          const agent = PLAN_AGENTS[this._step];
          log.engine(`Recovered plan phase: session=${this._session}, step ${this._step + 1}/${PLAN_AGENTS.length} (${agent ? agent.name : '?'})`);
          return;
        }
      }
    }

    // Check phase3 (develop)
    const phase3Path = path.join(projectRoot, '.yuri', 'state', 'phase3.yaml');
    if (fs.existsSync(phase3Path)) {
      const phase3 = yaml.load(fs.readFileSync(phase3Path, 'utf8')) || {};
      if (phase3.status === 'in_progress' && phase3.tmux && phase3.tmux.session) {
        if (tmx.hasSession(phase3.tmux.session)) {
          this._phase = 'develop';
          this._projectRoot = projectRoot;
          this._session = phase3.tmux.session;
          this._devStartedAt = phase3.started_at ? new Date(phase3.started_at).getTime() : Date.now();
          this._lastReportTime = Date.now(); // don't send report immediately on recover

          const pollInterval = this.config.dev_poll_interval || 300000;
          this._timer = setInterval(() => this._pollDevSession(), pollInterval);

          log.engine(`Recovered dev phase: session=${this._session}`);
          return;
        }
      }
    }
  }

  /**
   * Capture the current agent's tmux pane content for Claude context injection.
   * Returns a formatted string or null if no agent is active.
   */
  captureCurrentAgentContext() {
    if (!this._phase || !this._session || !tmx.hasSession(this._session)) {
      return null;
    }

    if (this._phase === 'plan') {
      const agent = PLAN_AGENTS[this._step];
      if (!agent) return null;

      const pane = tmx.capturePane(this._session, agent.window, 40);
      if (!pane.trim()) return null;

      const waiting = this._waitingForInput ? ' (WAITING FOR YOUR INPUT)' : '';
      return `[LIVE AGENT CONTEXT] Phase: plan, Agent: ${agent.name} (${this._step + 1}/${PLAN_AGENTS.length})${waiting}\n` +
             `tmux session: ${this._session}, window: ${agent.window}\n` +
             `--- Agent output (last 40 lines) ---\n${pane}\n--- End agent output ---`;
    }

    if (this._phase === 'develop') {
      // Capture all 4 dev windows briefly
      const windows = ['Architect', 'SM', 'Dev', 'QA'];
      const summaries = [];
      for (let w = 0; w < 4; w++) {
        const tail = tmx.capturePane(this._session, w, 5);
        const lastLine = tail.split('\n').filter((l) => l.trim()).pop() || '(empty)';
        summaries.push(`  Window ${w} (${windows[w]}): ${lastLine.trim().slice(0, 80)}`);
      }
      return `[LIVE AGENT CONTEXT] Phase: develop, Session: ${this._session}\n${summaries.join('\n')}`;
    }

    return null;
  }

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
      const progress = this._gatherDevProgress();
      const card = this._buildProgressCard(progress);
      return {
        phase: 'develop',
        message: card,
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

    // Check if the current agent's window already has Claude Code running.
    // This happens when gateway restarts while an agent is mid-execution.
    // In that case, just start polling — don't re-send commands.
    const agent = PLAN_AGENTS[this._step];
    const windowHasActivity = this._isWindowActive(agent.window);

    if (windowHasActivity) {
      log.engine(`Agent ${this._step + 1} (${agent.name}) already active in window ${agent.window}, resuming polling`);
    } else {
      try {
        this._startPlanAgent(this._step);
      } catch (err) {
        this._phase = null;
        return `❌ Failed to start agent: ${err.message}`;
      }
    }

    // Start polling
    const pollInterval = this.config.phase_poll_interval || 30000;
    this._timer = setInterval(() => this._pollPlanAgent(), pollInterval);

    const currentAgent = PLAN_AGENTS[this._step];
    return `🚀 Planning ${windowHasActivity ? 'resumed' : 'started'}! Agent ${this._step + 1}/${PLAN_AGENTS.length} (${currentAgent.name}) is running.\n\nI'll notify you as each agent completes. You can ask me anything in the meantime.`;
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

    // Skip polling while waiting for user input
    if (this._waitingForInput) return;

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
        // Content stable for 3 polls — distinguish "done" vs "waiting for input"
        const pane = tmx.capturePane(this._session, agent.window, 30);
        const tail = pane.split('\n').slice(-15).join('\n');

        if (/[A-Z][a-z]*ed for \d+/.test(tail)) {
          // Completion message present — truly done
          this._onAgentComplete(agent);
        } else if (this._looksLikeQuestion(tail)) {
          // Agent is asking a question — bridge to user
          this._onAgentWaitingInput(agent, tail);
        } else {
          // Ambiguous — treat as done (agent may have finished without completion message)
          log.engine(`Agent ${agent.name} stable without completion message, treating as done`);
          this._onAgentComplete(agent);
        }
        return;
      }
    } else {
      this._stableCount = 0;
      this._lastHash = result.hash || '';
    }
  }

  /**
   * Detect if pane content looks like the agent is asking a question.
   */
  _looksLikeQuestion(tail) {
    // Has question mark near the end
    if (/[?？]\s*$/.test(tail) || /[?？]\s*\n\s*❯/m.test(tail)) return true;
    // Has numbered options (1. xxx  2. xxx)
    if (/^\s*[1-9]\.\s+\S/m.test(tail) && /❯/.test(tail)) return true;
    // Has Y/N prompt
    if (/\(Y\/N\)/i.test(tail) || /\(y\/n\)/i.test(tail)) return true;
    // Has "please confirm" or similar
    if (/confirm|choose|select|which|请选择|请确认|是否/i.test(tail) && /❯/.test(tail)) return true;
    return false;
  }

  /**
   * Agent is waiting for user input. Notify user via Telegram and pause polling.
   */
  async _onAgentWaitingInput(agent, paneContent) {
    this._waitingForInput = true;

    // Extract the question from pane content (last meaningful lines before ❯)
    const lines = paneContent.split('\n');
    const promptIdx = lines.findLastIndex((l) => /❯/.test(l));
    const questionLines = lines.slice(Math.max(0, promptIdx - 15), promptIdx).filter((l) => l.trim());
    const question = questionLines.join('\n').trim() || '(unable to extract question)';

    log.engine(`Agent ${agent.name} is asking a question, notifying user`);

    const notification = `📋 **${agent.name}** is asking:\n\n${question}\n\n↩️ *Reply to this message to answer the agent.*`;

    try {
      const result = await this._onQuestionAsked(notification);
      if (result && result.messageId) {
        this._waitingMessageId = String(result.messageId);
      }
    } catch (err) {
      log.warn(`Failed to send question notification: ${err.message}`);
      // Auto-continue on failure
      this._waitingForInput = false;
    }
  }

  /**
   * Relay user's reply to the agent's tmux window.
   * Called by router when user replies to the question notification.
   */
  relayUserInput(text) {
    if (!this._waitingForInput || !this._session) {
      return false;
    }

    const agent = PLAN_AGENTS[this._step];
    if (!agent) return false;

    log.engine(`Relaying user input to ${agent.name}: "${text.slice(0, 50)}..."`);

    tmx.sendKeysWithEnter(this._session, agent.window, text);

    // Resume polling
    this._waitingForInput = false;
    this._waitingMessageId = null;
    this._stableCount = 0;
    this._lastHash = '';

    return true;
  }

  /**
   * Get the Telegram message_id of the current question notification.
   * Used by router to check if a reply-to matches.
   */
  getWaitingMessageId() {
    return this._waitingMessageId;
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

  /**
   * Check if a tmux window has an active Claude Code session.
   * Returns true if ❯ prompt or processing indicators are visible.
   */
  _isWindowActive(windowIdx) {
    if (!this._session || !tmx.hasSession(this._session)) return false;
    const pane = tmx.capturePane(this._session, windowIdx, 15);
    // ❯ means Claude Code is running (idle or processing)
    return /❯/.test(pane);
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
    this._devStartedAt = Date.now();
    this._lastReportTime = Date.now();

    const reportMin = Math.round(this._reportInterval / 60000);
    log.engine(`Dev phase started: session=${this._session}, report every ${reportMin}min`);
    return `🚀 Development started! 4 agents (Architect, SM, Dev, QA) are running.\n\nAgents chain automatically via handoff-detector. I'll send a progress report every ${reportMin} minutes.`;
  }

  _pollDevSession() {
    if (this._phase !== 'develop') return;

    if (!tmx.hasSession(this._session)) {
      this._handleError('develop', 'Dev tmux session died unexpectedly');
      return;
    }

    // Gather progress data
    const progress = this._gatherDevProgress();

    // Check if all stories done
    if (progress.totalStories > 0 && progress.doneStories >= progress.totalStories) {
      this._completeDev();
      return;
    }

    // Periodic progress report
    const now = Date.now();
    if (now - this._lastReportTime >= this._reportInterval) {
      this._lastReportTime = now;
      const card = this._buildProgressCard(progress);
      this.onProgress(card);
    }
  }

  /**
   * Gather dev progress from story files + tmux panes.
   */
  _gatherDevProgress() {
    const result = {
      totalEpics: 0, doneEpics: 0,
      totalStories: 0, doneStories: 0,
      byStatus: {},
      currentAgent: null, currentWindow: null, currentStory: null,
      runningFor: this._devStartedAt ? Date.now() - this._devStartedAt : 0,
    };

    // Method 1: scan-stories.sh
    const scriptPath = path.join(SKILL_DIR, 'scripts', 'scan-stories.sh');
    if (fs.existsSync(scriptPath) && this._projectRoot) {
      try {
        const output = execSync(`bash "${scriptPath}" "${this._projectRoot}"`, {
          encoding: 'utf8', timeout: 10000,
        }).trim();

        if (output && output !== 'NO_STORIES_DIR') {
          for (const line of output.split('\n')) {
            const [key, countStr] = line.split(':');
            const count = parseInt(countStr, 10) || 0;
            if (key === 'Epics') {
              result.totalEpics = count;
            } else if (key && count > 0) {
              result.byStatus[key] = count;
              result.totalStories += count;
              if (key === 'Done') result.doneStories += count;
            }
          }
        }
      } catch { /* fallback to phase3.yaml */ }
    }

    // Method 2: phase3.yaml fallback
    if (result.totalStories === 0) {
      const phase3Path = path.join(this._projectRoot, '.yuri', 'state', 'phase3.yaml');
      if (fs.existsSync(phase3Path)) {
        try {
          const phase3 = yaml.load(fs.readFileSync(phase3Path, 'utf8')) || {};
          const p = phase3.progress || {};
          result.totalStories = p.total_stories || 0;
          result.totalEpics = p.total_epics || 0;
          const bs = p.by_status || {};
          result.doneStories = (bs.done || 0) + (bs.complete || 0);
          result.byStatus = bs;
        } catch { /* ok */ }
      }
    }

    // Count epics from docs/prd/ (epic YAML/MD files) as fallback
    if (result.totalEpics === 0) {
      const prdDir = path.join(this._projectRoot, 'docs', 'prd');
      if (fs.existsSync(prdDir)) {
        try {
          result.totalEpics = fs.readdirSync(prdDir).filter((f) => /^epic/i.test(f)).length;
        } catch { /* ok */ }
      }
    }

    // Detect current active agent from tmux panes
    if (this._session && tmx.hasSession(this._session)) {
      const windowNames = ['Architect', 'SM', 'Dev', 'QA'];
      for (let w = 0; w < 4; w++) {
        const pane = tmx.capturePane(this._session, w, 5);
        // Active = has processing indicator (●) or recent output (not just ❯)
        const lines = pane.split('\n').filter((l) => l.trim());
        const lastLine = lines[lines.length - 1] || '';
        if (/●|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(pane) || (lines.length > 2 && !/^❯\s*$/.test(lastLine))) {
          result.currentAgent = windowNames[w];
          result.currentWindow = w;

          // Try to extract story ID from pane content
          const storyMatch = pane.match(/story[_-]?\d+[\._-]\d+/i) || pane.match(/\d+\.\d+/);
          if (storyMatch) result.currentStory = storyMatch[0];
          break;
        }
      }
    }

    return result;
  }

  /**
   * Build a formatted progress card for Telegram/Feishu.
   */
  _buildProgressCard(p) {
    const pct = p.totalStories > 0 ? Math.round(p.doneStories / p.totalStories * 100) : 0;
    const bar = this._progressBar(pct);
    const elapsed = this._formatDuration(p.runningFor);

    const lines = [
      `📊 **Dev Progress Report**`,
      `━━━━━━━━━━━━━━━━━━━━━`,
    ];

    if (p.totalEpics > 0) {
      lines.push(`Epic: ${p.doneEpics}/${p.totalEpics}`);
    }
    lines.push(`Story: ${p.doneStories}/${p.totalStories} (${pct}%)`);
    lines.push(`${bar}`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━`);

    // Status breakdown
    const statusEntries = Object.entries(p.byStatus).filter(([, v]) => v > 0);
    if (statusEntries.length > 0) {
      const statusIcons = {
        Done: '✅', InProgress: '🔄', Review: '👀', Blocked: '🚫',
        Approved: '✅', AwaitingArchReview: '🏛️', RequiresRevision: '🔧', Escalated: '⚠️',
      };
      for (const [status, count] of statusEntries) {
        lines.push(`${statusIcons[status] || '·'} ${status}: ${count}`);
      }
      lines.push(`━━━━━━━━━━━━━━━━━━━━━`);
    }

    // Current activity
    if (p.currentAgent) {
      const storyInfo = p.currentStory ? ` → ${p.currentStory}` : '';
      lines.push(`Current: ${p.currentAgent} (window ${p.currentWindow})${storyInfo}`);
    } else {
      lines.push(`Current: waiting for next handoff`);
    }

    lines.push(`⏱ Running for ${elapsed}`);

    return lines.join('\n');
  }

  _progressBar(pct) {
    const total = 20;
    const filled = Math.round(pct / 100 * total);
    const empty = total - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${pct}%`;
  }

  _formatDuration(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 60) return `${min}min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}h ${m}min`;
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
