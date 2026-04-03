'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const tmx = require('./tmux-utils');
const { log } = require('../log');
const { msg } = require('./messages');

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

    this._phase = null;       // 'plan' | 'develop' | 'test' | 'iterate' | 'change' | null
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
          this._lastActiveAgent = null;

          const pollInterval = this.config.dev_poll_interval || 300000;
          this._timer = setInterval(() => this._pollDevSession(), pollInterval);

          log.engine(`Recovered dev phase: session=${this._session}`);
          return;
        }
      }
    }

    // Check phase4 (test)
    const phase4Path = path.join(projectRoot, '.yuri', 'state', 'phase4.yaml');
    if (fs.existsSync(phase4Path)) {
      const phase4 = yaml.load(fs.readFileSync(phase4Path, 'utf8')) || {};
      if (phase4.status === 'in_progress' && Array.isArray(phase4.epics)) {
        // Find a live orchestrix tmux session
        let session = null;
        try {
          const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf8' }).trim();
          session = sessions.split('\n').find((s) => s.startsWith('orchestrix-'));
        } catch { /* no sessions */ }

        if (session && tmx.hasSession(session)) {
          const epicIds = phase4.epics.map((e) => String(e.id));
          const firstPending = epicIds.findIndex((id) => {
            const e = phase4.epics.find((ep) => String(ep.id) === id);
            return !e || (e.status !== 'passed' && e.status !== 'failed');
          });

          if (firstPending >= 0) {
            this._phase = 'test';
            this._projectRoot = projectRoot;
            this._session = session;
            this._lastHash = '';
            this._stableCount = 0;
            this._testBusy = false;

            // Rebuild results from already-tested epics
            const results = {};
            for (const e of phase4.epics) {
              if (e.status === 'passed' || e.status === 'failed') {
                results[e.id] = { status: e.status, rounds: e.rounds || 0 };
              }
            }

            this._testContext = {
              epicIds,
              epicIdx: firstPending,
              round: 0,
              maxRounds: 3,
              subPhase: null,
              results,
            };

            this._loadAndTestEpic();

            const pollInterval = this.config.phase_poll_interval || 30000;
            this._timer = setInterval(() => this._pollTest(), pollInterval);

            log.engine(`Recovered test phase: session=${session}, resuming at epic idx ${firstPending}`);
            return;
          }
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
             `--- Agent output (last 40 lines) ---\n${pane}\n--- End agent output ---`;
    }

    if (this._phase === 'develop') {
      // Capture all 4 dev windows briefly
      const windows = ['Architect', 'SM', 'Dev', 'QA'];
      const summaries = [];
      for (let w = 0; w < 4; w++) {
        const tail = tmx.capturePane(this._session, w, 5);
        const lastLine = tail.split('\n').filter((l) => l.trim()).pop() || '(empty)';
        summaries.push(`  ${windows[w]}: ${lastLine.trim().slice(0, 80)}`);
      }
      return `[LIVE AGENT CONTEXT] Phase: develop\n${summaries.join('\n')}`;
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

    if (this._phase === 'test') {
      const card = this._buildTestProgressCard();
      return { phase: 'test', message: card };
    }

    if (this._phase === 'iterate') {
      const ctx = this._changeContext || {};
      const agentLabels = { pm: 'PM generating next-steps', architect: 'Architect resolving changes' };
      const label = agentLabels[ctx.iteratePhase] || ctx.iteratePhase || 'starting';
      return { phase: 'iterate', message: `🔄 Iteration in progress\n📍 ${label} (${this._step + 1}/2)` };
    }

    if (this._phase === 'change') {
      const ctx = this._changeContext || {};
      const stepLabels = ['PO routing change', 'Architect resolving', 'SM applying proposal'];
      const stepLabel = stepLabels[this._step] || `Step ${this._step + 1}`;
      return {
        phase: 'change',
        message: `🔧 Change in progress (${ctx.scope || '?'})\n📍 ${stepLabel} (${this._step + 1}/3)`,
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

    // Build output summary
    const outputs = [];
    for (const agent of PLAN_AGENTS) {
      if (agent.output) {
        const outputPath = path.join(this._projectRoot, agent.output);
        const exists = fs.existsSync(outputPath);
        outputs.push(`  ${exists ? '✅' : '⚠️'} ${agent.name} → ${agent.output}`);
      }
    }
    const outputSummary = outputs.length > 0 ? `\n\n${outputs.join('\n')}` : '';

    log.engine('Plan phase complete');
    this.onComplete('plan', msg('plan_complete', { summary: outputSummary }));
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
    this._lastActiveAgent = null;

    const reportMin = Math.round(this._reportInterval / 60000);
    log.engine(`Dev phase started: session=${this._session}, report every ${reportMin}min`);
    return msg('dev_started', { minutes: reportMin });
  }

  _pollDevSession() {
    if (this._phase !== 'develop') return;

    if (!tmx.hasSession(this._session)) {
      this._handleError('develop', 'Dev tmux session died unexpectedly');
      return;
    }

    // Gather progress data
    const progress = this._gatherDevProgress();

    // Detect agent handoff and notify user
    if (progress.currentAgent && progress.currentAgent !== this._lastActiveAgent) {
      const prev = this._lastActiveAgent;
      this._lastActiveAgent = progress.currentAgent;
      if (prev) {
        const storyInfo = progress.currentStory ? ` — working on ${progress.currentStory}` : '';
        this.onProgress(`🔄 ${prev} → **${progress.currentAgent}**${storyInfo}`);
      }
    } else if (progress.currentAgent) {
      this._lastActiveAgent = progress.currentAgent;
    }

    // Check if all stories done — but ONLY if no agent is actively working.
    // If an agent is busy (e.g., SM drafting new stories), story counts are stale.
    if (progress.totalStories > 0 && progress.doneStories >= progress.totalStories) {
      if (progress.currentAgent) {
        // Agent still working — stories may be in flux (new ones being created)
        log.engine(`All ${progress.doneStories}/${progress.totalStories} stories done but ${progress.currentAgent} is still active — waiting`);
      } else {
        // No active agent + all stories done → truly complete
        this._completeDev();
        return;
      }
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
      totalEpics: 0, currentEpic: 0,
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
            if (!line.includes(':')) continue;
            const colonIdx = line.indexOf(':');
            const key = line.slice(0, colonIdx);
            const value = line.slice(colonIdx + 1);

            if (key === 'Total') {
              result.totalStories = parseInt(value, 10) || 0;
            } else if (key === 'Epics') {
              result.totalEpics = parseInt(value, 10) || 0;
            } else if (key === 'CurrentEpic') {
              result.currentEpic = parseInt(value, 10) || 0;
            } else if (key === 'CurrentStory') {
              if (!result.currentStory) result.currentStory = value;
            } else if (key.startsWith('Status')) {
              // Per-file status: StatusDone:1.1-name → count as 'Done'
              const statusName = key.slice(6); // strip 'Status' prefix
              result.byStatus[statusName] = (result.byStatus[statusName] || 0) + 1;
              if (statusName === 'Done') result.doneStories++;
            }
            // 'Created' is metadata — skip (Total is the authoritative count)
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
          const epicNums = fs.readdirSync(prdDir)
            .map((f) => { const m = f.match(/^epic-(\d+)/i); return m ? parseInt(m[1], 10) : 0; })
            .filter((n) => n > 0);
          result.totalEpics = epicNums.length > 0 ? Math.max(...epicNums) : 0;
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
      lines.push(`Epic: ${p.currentEpic}/${p.totalEpics}`);
    }
    lines.push(`Story: ${p.doneStories}/${p.totalStories} (${pct}%)`);
    lines.push(`${bar}`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━`);

    // Status breakdown
    const statusEntries = Object.entries(p.byStatus).filter(([, v]) => v > 0);
    if (statusEntries.length > 0) {
      const statusIcons = {
        Done: '✅', InProgress: '🔄', Review: '👀', Blocked: '🚫',
        Approved: '📋', Draft: '📝', NoStatus: '❓',
        AwaitingArchReview: '🏛️', RequiresRevision: '🔧', Escalated: '⚠️',
      };
      for (const [status, count] of statusEntries) {
        lines.push(`${statusIcons[status] || '·'} ${status}: ${count}`);
      }
      lines.push(`━━━━━━━━━━━━━━━━━━━━━`);
    }

    // Current activity
    if (p.currentAgent) {
      const storyInfo = p.currentStory ? ` → ${p.currentStory}` : '';
      lines.push(`Current: ${p.currentAgent}${storyInfo}`);
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

    // Update state files so auto-reporter stops
    try {
      const phase3Path = path.join(this._projectRoot, '.yuri', 'state', 'phase3.yaml');
      if (fs.existsSync(phase3Path)) {
        const phase3 = yaml.load(fs.readFileSync(phase3Path, 'utf8')) || {};
        phase3.status = 'complete';
        phase3.completed_at = new Date().toISOString();
        fs.writeFileSync(phase3Path, yaml.dump(phase3, { lineWidth: -1 }));
      }

      const focusPath = path.join(this._projectRoot, '.yuri', 'focus.yaml');
      if (fs.existsSync(focusPath)) {
        const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
        focus.step = 'phase3.complete';
        focus.pulse = 'Phase 3 complete, all stories done';
        focus.updated_at = new Date().toISOString();
        fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
      }
    } catch (err) {
      log.warn(`Failed to update state files on dev complete: ${err.message}`);
    }

    log.engine('Dev phase complete');
    this.onComplete('develop', msg('dev_complete'));

    // Auto-chain: start test phase immediately after dev completes.
    // This makes "develop all stories then test" a single unattended flow.
    try {
      const result = this.startTest(this._projectRoot);
      log.engine(`Auto-chained to test phase: ${result.slice(0, 80)}`);
      this.onProgress(result);
    } catch (err) {
      log.warn(`Auto-chain to test failed: ${err.message}`);
    }
  }

  // ── Test Phase ──────────────────────────────────────────────────────────────

  /**
   * Start test phase: QA smoke test per epic, auto fix-retest loop.
   * Uses existing dev session's QA window (3) and Dev window (2).
   *
   * State machine subPhases: qa-loading → qa-testing → (on fail) dev-loading → dev-fixing → qa-loading ...
   */
  startTest(projectRoot) {
    if (this._phase) {
      return `⚠️ Phase "${this._phase}" is already running. Use *status to check.`;
    }

    this._projectRoot = projectRoot;
    this._phase = 'test';
    this._lastHash = '';
    this._stableCount = 0;
    this._testBusy = false;

    // Ensure dev session exists (QA is window 3, Dev is window 2)
    try {
      const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
      const result = execSync(`bash "${scriptPath}" dev "${projectRoot}"`, {
        encoding: 'utf8', timeout: 60000,
      }).trim();
      const lines = result.split('\n');
      this._session = lines[lines.length - 1].trim();
    } catch (err) {
      this._phase = null;
      return `❌ Failed to ensure dev session: ${err.message}`;
    }

    // Collect epic list from PRD files
    const prdDir = path.join(projectRoot, 'docs', 'prd');
    let epicIds = [];
    try {
      if (fs.existsSync(prdDir)) {
        epicIds = fs.readdirSync(prdDir)
          .filter((f) => /^epic-\d+/.test(f) && f.endsWith('.yaml'))
          .map((f) => f.replace(/^epic-/, '').replace(/\.yaml$/, ''))
          .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      }
    } catch { /* ignore */ }

    if (epicIds.length === 0) {
      this._phase = null;
      return '❌ No epic files found in docs/prd/. Nothing to test.';
    }

    // Initialize or resume phase4.yaml state
    const phase4Path = path.join(projectRoot, '.yuri', 'state', 'phase4.yaml');
    let startIdx = 0;
    try {
      if (fs.existsSync(phase4Path)) {
        const existing = yaml.load(fs.readFileSync(phase4Path, 'utf8')) || {};
        if (existing.status === 'in_progress' && Array.isArray(existing.epics)) {
          // Resume: find first non-passed epic
          const idx = epicIds.findIndex((id) => {
            const e = existing.epics.find((ep) => String(ep.id) === String(id));
            return !e || e.status !== 'passed';
          });
          if (idx >= 0) startIdx = idx;
        }
      }

      // Write initial state
      const epicsState = epicIds.map((id, i) => ({
        id, status: i < startIdx ? 'passed' : 'pending', rounds: 0, last_tested_at: '',
      }));
      const state = { status: 'in_progress', started_at: new Date().toISOString(), completed_at: '', epics: epicsState, regression_rounds: 0 };
      fs.writeFileSync(phase4Path, yaml.dump(state, { lineWidth: -1 }));
    } catch (err) {
      log.warn(`Failed to init phase4.yaml: ${err.message}`);
    }

    // Update focus.yaml
    try {
      const focusPath = path.join(projectRoot, '.yuri', 'focus.yaml');
      if (fs.existsSync(focusPath)) {
        const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
        focus.phase = 4;
        focus.step = 'testing';
        focus.action = 'starting smoke tests';
        focus.pulse = `Phase 4: testing 0/${epicIds.length} epics`;
        focus.updated_at = new Date().toISOString();
        fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
      }
    } catch { /* ignore */ }

    // Initialize test context
    this._testContext = {
      epicIds,
      epicIdx: startIdx,
      round: 0,
      maxRounds: 3,
      subPhase: null, // set by _loadAndTestEpic
      results: {},
    };

    // Start first epic test
    this._loadAndTestEpic();
    this._testStartedAt = Date.now();
    this._lastReportTime = Date.now();

    const pollInterval = this.config.phase_poll_interval || 30000;
    this._timer = setInterval(() => this._pollTest(), pollInterval);

    const reportMin = Math.round(this._reportInterval / 60000);
    log.engine(`Test phase started: session=${this._session}, epics=${epicIds.join(',')}, startIdx=${startIdx}, report every ${reportMin}min`);
    return `🧪 Testing started! ${epicIds.length} epic(s) to test.\n\nQA will smoke-test each epic. Failed tests auto-trigger Dev fixes (max 3 rounds).\nI'll notify you of results.`;
  }

  /**
   * Reload QA agent and send *smoke-test for current epic.
   */
  _loadAndTestEpic() {
    const ctx = this._testContext;
    const epicId = ctx.epicIds[ctx.epicIdx];

    this._testBusy = true;
    this._lastHash = '';
    this._stableCount = 0;

    try {
      tmx.sendKeysWithEnter(this._session, 3, '/clear');
      execSync('sleep 2');
      tmx.sendKeysWithEnter(this._session, 3, '/o qa');
      execSync('sleep 12');
      tmx.sendKeysWithEnter(this._session, 3, `*smoke-test ${epicId}`);
    } catch (err) {
      this._testBusy = false;
      this._handleError('test', `Failed to start QA for epic ${epicId}: ${err.message}`);
      return;
    }

    ctx.subPhase = 'qa-testing';
    this._testBusy = false;
    log.engine(`QA testing epic ${epicId} (round ${ctx.round + 1}/${ctx.maxRounds})`);
  }

  /**
   * Reload Dev agent and send *quick-fix for the detected bug.
   */
  _loadAndFixEpic(bugDesc) {
    this._testBusy = true;
    this._lastHash = '';
    this._stableCount = 0;

    try {
      tmx.sendKeysWithEnter(this._session, 2, '/clear');
      execSync('sleep 2');
      tmx.sendKeysWithEnter(this._session, 2, '/o dev');
      execSync('sleep 12');

      // Escape quotes in bug description
      const safeBug = (bugDesc || 'smoke test failure').replace(/"/g, '\\"');
      tmx.sendKeysWithEnter(this._session, 2, `*quick-fix "${safeBug}"`);
    } catch (err) {
      this._testBusy = false;
      this._handleError('test', `Failed to start Dev fix: ${err.message}`);
      return;
    }

    this._testContext.subPhase = 'dev-fixing';
    this._testBusy = false;
    log.engine(`Dev fixing: ${bugDesc}`);
  }

  /**
   * Capture QA pane output and determine PASS/FAIL.
   */
  _evaluateTestResult() {
    const output = tmx.capturePane(this._session, 3, 200);
    const lines = output.split('\n');
    const tail = lines.slice(-50).join('\n');

    // PASS indicators
    if (/all\s+tests?\s+passed/i.test(tail) || /✅.*pass/i.test(tail) || /smoke.*pass/i.test(tail) || /PASS/i.test(tail)) {
      return { passed: true, bugDesc: null };
    }

    // FAIL: extract bug description near failure markers
    let bugDesc = 'smoke test failure';
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
      if (/fail|❌|error|FAIL/i.test(lines[i])) {
        // Take up to 3 lines around the failure for context
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        bugDesc = lines.slice(start, end).join(' ').trim().substring(0, 200);
        break;
      }
    }

    return { passed: false, bugDesc };
  }

  /**
   * State machine poll for test phase.
   */
  _pollTest() {
    if (this._phase !== 'test') return;
    if (this._testBusy) return;

    const ctx = this._testContext;
    if (!ctx) return;

    if (!tmx.hasSession(this._session)) {
      this._handleError('test', 'tmux session died');
      return;
    }

    // Periodic progress report (reuses dev phase's _reportInterval)
    const now = Date.now();
    if (now - this._lastReportTime >= this._reportInterval) {
      this._lastReportTime = now;
      const card = this._buildTestProgressCard();
      this.onProgress(card);
    }

    // Determine which window to watch
    const window = ctx.subPhase === 'dev-fixing' ? 2 : 3;
    const result = tmx.checkCompletion(this._session, window, this._lastHash);

    // Not done yet
    if (result.status !== 'complete' && !(result.status === 'stable' && ++this._stableCount >= 3)) {
      if (result.status !== 'stable') { this._stableCount = 0; this._lastHash = result.hash || ''; }
      else { this._lastHash = result.hash; }
      return;
    }

    // Agent finished — reset counters
    this._stableCount = 0;
    this._lastHash = '';

    const epicId = ctx.epicIds[ctx.epicIdx];

    if (ctx.subPhase === 'qa-testing') {
      const testResult = this._evaluateTestResult();

      if (testResult.passed) {
        ctx.results[epicId] = { status: 'passed', rounds: ctx.round + 1 };
        this._updateTestState(epicId, 'passed', ctx.round + 1);
        this.onProgress(`✅ Epic ${epicId} passed (${ctx.round + 1} round(s))`);
        log.engine(`Epic ${epicId} PASSED after ${ctx.round + 1} round(s)`);
        this._advanceToNextEpic();
      } else if (ctx.round + 1 >= ctx.maxRounds) {
        ctx.results[epicId] = { status: 'failed', rounds: ctx.round + 1 };
        this._updateTestState(epicId, 'failed', ctx.round + 1);
        this.onProgress(`❌ Epic ${epicId} failed after ${ctx.round + 1} rounds.\nLast error: ${testResult.bugDesc}`);
        log.engine(`Epic ${epicId} FAILED after ${ctx.round + 1} rounds`);
        this._advanceToNextEpic();
      } else {
        ctx.round++;
        this.onProgress(`���️ Epic ${epicId} failed (round ${ctx.round}/${ctx.maxRounds}). Sending to Dev for fix...`);
        log.engine(`Epic ${epicId} failed round ${ctx.round}, sending to Dev`);
        this._loadAndFixEpic(testResult.bugDesc);
      }
    } else if (ctx.subPhase === 'dev-fixing') {
      this.onProgress(`🔧 Dev fix done for epic ${epicId}. Retesting...`);
      log.engine(`Dev fix done for epic ${epicId}, retesting`);
      this._loadAndTestEpic();
    }
  }

  /**
   * Advance to next epic or complete test phase.
   */
  _advanceToNextEpic() {
    const ctx = this._testContext;
    ctx.epicIdx++;
    ctx.round = 0;

    const tested = ctx.epicIdx;
    const total = ctx.epicIds.length;

    // Update focus pulse
    try {
      const focusPath = path.join(this._projectRoot, '.yuri', 'focus.yaml');
      if (fs.existsSync(focusPath)) {
        const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
        focus.pulse = `Phase 4: ${tested}/${total} epics tested`;
        focus.updated_at = new Date().toISOString();
        fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
      }
    } catch { /* ignore */ }

    if (ctx.epicIdx >= ctx.epicIds.length) {
      this._completeTest();
      return;
    }

    // Start next epic
    this._loadAndTestEpic();
  }

  /**
   * Update a single epic's status in phase4.yaml.
   */
  _updateTestState(epicId, status, rounds) {
    try {
      const phase4Path = path.join(this._projectRoot, '.yuri', 'state', 'phase4.yaml');
      if (!fs.existsSync(phase4Path)) return;

      const state = yaml.load(fs.readFileSync(phase4Path, 'utf8')) || {};
      if (!Array.isArray(state.epics)) return;

      const epic = state.epics.find((e) => String(e.id) === String(epicId));
      if (epic) {
        epic.status = status;
        epic.rounds = rounds;
        epic.last_tested_at = new Date().toISOString();
      }
      state.regression_rounds = (state.regression_rounds || 0) + rounds;
      fs.writeFileSync(phase4Path, yaml.dump(state, { lineWidth: -1 }));
    } catch (err) {
      log.warn(`Failed to update phase4.yaml for epic ${epicId}: ${err.message}`);
    }
  }

  /**
   * Build a progress card for the test phase (used by getStatus + periodic reports).
   */
  _buildTestProgressCard() {
    const ctx = this._testContext;
    if (!ctx) return '🧪 Testing in progress.';

    const total = ctx.epicIds.length;
    const passed = Object.values(ctx.results).filter((r) => r.status === 'passed').length;
    const failed = Object.values(ctx.results).filter((r) => r.status === 'failed').length;
    const tested = passed + failed;
    const pct = total > 0 ? Math.round((tested / total) * 100) : 0;

    const currentEpic = ctx.epicIds[ctx.epicIdx];
    const subPhaseLabel = {
      'qa-testing': '🔍 QA smoke-testing',
      'dev-fixing': '🔧 Dev fixing bug',
    }[ctx.subPhase] || '⏳ Loading agent';

    const elapsed = this._devStartedAt ? this._formatDuration(Date.now() - this._devStartedAt) : '';
    const startedAt = this._testStartedAt ? this._formatDuration(Date.now() - this._testStartedAt) : '';

    const lines = [
      `🧪 **Test Phase Progress**`,
      ``,
      this._progressBar(pct),
      ``,
      `📊 Epics: ${tested}/${total} tested (✅ ${passed} passed, ❌ ${failed} failed)`,
    ];

    if (ctx.epicIdx < total) {
      lines.push(`🎯 Current: Epic ${currentEpic} — ${subPhaseLabel} (round ${ctx.round + 1}/${ctx.maxRounds})`);
    }

    // Per-epic summary
    if (tested > 0) {
      lines.push('', '📋 Results:');
      for (const epicId of ctx.epicIds) {
        const r = ctx.results[epicId];
        if (r && r.status === 'passed') {
          lines.push(`  ✅ Epic ${epicId} — passed (${r.rounds} round(s))`);
        } else if (r && r.status === 'failed') {
          lines.push(`  ❌ Epic ${epicId} — failed (${r.rounds} rounds)`);
        } else if (epicId === currentEpic) {
          lines.push(`  ⏳ Epic ${epicId} — in progress`);
        } else {
          lines.push(`  ⬜ Epic ${epicId} — pending`);
        }
      }
    }

    if (startedAt) lines.push(`\n⏱️ Elapsed: ${startedAt}`);

    return lines.join('\n');
  }

  /**
   * Complete test phase: aggregate results, update state files, send summary.
   */
  _completeTest() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }

    const ctx = this._testContext;
    const passed = Object.values(ctx.results).filter((r) => r.status === 'passed').length;
    const failed = Object.values(ctx.results).filter((r) => r.status === 'failed').length;
    const total = ctx.epicIds.length;

    // Update phase4.yaml
    try {
      const phase4Path = path.join(this._projectRoot, '.yuri', 'state', 'phase4.yaml');
      if (fs.existsSync(phase4Path)) {
        const state = yaml.load(fs.readFileSync(phase4Path, 'utf8')) || {};
        state.status = failed > 0 ? 'complete_with_failures' : 'complete';
        state.completed_at = new Date().toISOString();
        fs.writeFileSync(phase4Path, yaml.dump(state, { lineWidth: -1 }));
      }
    } catch (err) {
      log.warn(`Failed to finalize phase4.yaml: ${err.message}`);
    }

    // Update focus.yaml
    try {
      const focusPath = path.join(this._projectRoot, '.yuri', 'focus.yaml');
      if (fs.existsSync(focusPath)) {
        const focus = yaml.load(fs.readFileSync(focusPath, 'utf8')) || {};
        focus.step = 'phase4.complete';
        focus.pulse = `Phase 4 complete: ${passed}/${total} passed`;
        focus.updated_at = new Date().toISOString();
        fs.writeFileSync(focusPath, yaml.dump(focus, { lineWidth: -1 }));
      }
    } catch { /* ignore */ }

    // Append timeline event
    try {
      const timelinePath = path.join(this._projectRoot, '.yuri', 'timeline', 'events.jsonl');
      const dir = path.dirname(timelinePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const event = JSON.stringify({ ts: new Date().toISOString(), type: 'phase_completed', phase: 4, passed, failed, total });
      fs.appendFileSync(timelinePath, event + '\n');
    } catch { /* ignore */ }

    // Build summary
    const lines = [`🧪 Testing complete! ${passed}/${total} epics passed.\n`];
    for (const epicId of ctx.epicIds) {
      const r = ctx.results[epicId];
      if (r && r.status === 'passed') {
        lines.push(`  ✅ Epic ${epicId} — passed (${r.rounds} round(s))`);
      } else if (r && r.status === 'failed') {
        lines.push(`  ❌ Epic ${epicId} — failed after ${r.rounds} rounds`);
      } else {
        lines.push(`  ⏭️ Epic ${epicId} — skipped`);
      }
    }

    if (failed === 0) {
      lines.push(msg('test_all_passed'));
    } else {
      lines.push(msg('test_some_failed', { count: failed }));
    }

    this._phase = null;
    this._testContext = null;
    this._testStartedAt = null;
    log.engine(`Test phase complete: ${passed}/${total} passed, ${failed} failed`);
    this.onComplete('test', lines.join('\n'));
  }

  // ── Iterate (New Iteration) ────────────────────────────────────────────────

  /**
   * Start a new iteration: PM generates next-steps, agents execute, SM starts dev.
   * Flow: PM *start-iteration → parse HANDOFF → execute agents → SM *draft → dev auto
   */
  startIterate(projectRoot) {
    if (this._phase) {
      return `⚠️ Phase "${this._phase}" is already running. Use *status to check.`;
    }

    this._projectRoot = projectRoot;
    this._phase = 'iterate';
    this._step = 0;
    this._lastHash = '';
    this._stableCount = 0;

    // Step 1: Ensure planning session
    try {
      const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
      const result = execSync(`bash "${scriptPath}" planning "${projectRoot}"`, {
        encoding: 'utf8', timeout: 60000,
      }).trim();
      const lines = result.split('\n');
      this._session = lines[lines.length - 1].trim();
    } catch (err) {
      this._phase = null;
      return `❌ Failed to create planning session: ${err.message}`;
    }

    // Start PM *start-iteration
    tmx.sendKeysWithEnter(this._session, 0, '/o pm');
    execSync('sleep 15');
    tmx.sendKeysWithEnter(this._session, 0, '*start-iteration');

    this._changeContext = { iteratePhase: 'pm' };
    const pollInterval = this.config.phase_poll_interval || 30000;
    this._timer = setInterval(() => this._pollIterate(), pollInterval);

    log.engine(`Iterate started: session=${this._session}`);
    return '🔄 New iteration started! PM is generating next-steps.\n\nAfter PM finishes, agents will execute in sequence, then dev automation resumes.';
  }

  _pollIterate() {
    if (this._phase !== 'iterate') return;
    if (this._waitingForInput) return;

    const ctx = this._changeContext;
    if (!ctx) return;

    if (!tmx.hasSession(this._session)) {
      this._handleError('iterate', 'tmux session died');
      return;
    }

    const result = tmx.checkCompletion(this._session, 0, this._lastHash);
    if (result.status === 'complete' || (result.status === 'stable' && ++this._stableCount >= 3)) {
      this._stableCount = 0;
      this._lastHash = '';
      this._step++;

      if (ctx.iteratePhase === 'pm') {
        // PM done → send to Architect for review
        this.onProgress('✅ PM generated next-steps. Sending to Architect...');
        ctx.iteratePhase = 'architect';
        tmx.sendKeysWithEnter(this._session, 0, '/clear');
        execSync('sleep 2');
        tmx.sendKeysWithEnter(this._session, 0, '/o architect');
        execSync('sleep 15');
        tmx.sendKeysWithEnter(this._session, 0, '*resolve-change');
      } else if (ctx.iteratePhase === 'architect') {
        // Architect done → transition to dev: SM *draft
        this.onProgress('✅ Architect resolved. Starting dev automation via SM...');
        try {
          const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
          const devResult = execSync(`bash "${scriptPath}" dev "${this._projectRoot}"`, {
            encoding: 'utf8', timeout: 120000,
          }).trim();
          const devLines = devResult.split('\n');
          const devSession = devLines[devLines.length - 1].trim();

          tmx.sendKeysWithEnter(devSession, 1, '/clear');
          execSync('sleep 2');
          tmx.sendKeysWithEnter(devSession, 1, '/o sm');
          execSync('sleep 12');
          tmx.sendKeysWithEnter(devSession, 1, '*draft');

          this._completeIterate(devSession);
        } catch (err) {
          this._handleError('iterate', `Failed to start dev: ${err.message}`);
        }
      }
      return;
    }

    if (result.status !== 'stable') { this._stableCount = 0; this._lastHash = result.hash || ''; }
    else { this._lastHash = result.hash; }
  }

  _completeIterate(devSession) {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    // Kill planning session (no longer needed)
    if (this._session && tmx.hasSession(this._session)) {
      tmx.killSession(this._session);
    }

    this._changeContext = null;
    log.engine('Iterate complete — dev automation started');
    this.onComplete('iterate', msg('iterate_launched'));

    // Transition to dev monitoring so SM → Architect → Dev → QA cycle is tracked.
    // Without this, the entire dev cycle runs unmonitored after iterate completes.
    if (devSession && tmx.hasSession(devSession)) {
      this._phase = 'develop';
      this._session = devSession;
      this._devStartedAt = Date.now();
      this._lastReportTime = Date.now();
      this._lastActiveAgent = null;
      this._stableCount = 0;
      this._lastHash = '';
      const pollInterval = this.config.dev_poll_interval || 300000;
      this._timer = setInterval(() => this._pollDevSession(), pollInterval);
      log.engine(`Iterate → dev monitoring: session=${devSession}, poll every ${Math.round(pollInterval / 60000)}min`);
      this.onProgress(msg('monitoring_dev'));
    } else {
      this._phase = null;
    }
  }

  // ── Quick Fix ───────────────────────────────────────────────────────────────

  /**
   * Execute a quick bug fix via Dev agent.
   * Sends *quick-fix to the Dev window — no scope assessment, immediate action.
   *
   * @param {string} projectRoot
   * @param {string} bugDesc — description of the bug/issue
   * @returns {string} immediate status message
   */
  startQuickFix(projectRoot, bugDesc) {
    if (this._phase) {
      return `⚠️ Phase "${this._phase}" is already running. Finish it first or *cancel.`;
    }

    this._projectRoot = projectRoot;
    this._phase = 'change';
    this._lastHash = '';
    this._stableCount = 0;

    try {
      const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
      const result = execSync(`bash "${scriptPath}" dev "${projectRoot}"`, {
        encoding: 'utf8', timeout: 60000,
      }).trim();
      const lines = result.split('\n');
      this._session = lines[lines.length - 1].trim();
    } catch (err) {
      this._phase = null;
      return `❌ Failed to ensure dev session: ${err.message}`;
    }

    // Reload Dev agent and send *quick-fix
    tmx.sendKeysWithEnter(this._session, 2, '/clear');
    execSync('sleep 2');
    tmx.sendKeysWithEnter(this._session, 2, '/o dev');
    execSync('sleep 12');

    const safeBug = (bugDesc || 'bug fix').replace(/"/g, '\\"');
    tmx.sendKeysWithEnter(this._session, 2, `*quick-fix "${safeBug}"`);

    // Poll for completion (reuses _pollChange which watches dev window 2)
    const pollInterval = this.config.phase_poll_interval || 30000;
    this._step = 0;
    this._changeContext = { scope: 'small', description: bugDesc };
    this._timer = setInterval(() => this._pollChange(), pollInterval);

    log.engine(`Quick fix started: "${bugDesc.slice(0, 60)}..."`);
    return msg('quickfix_started', { desc: bugDesc.slice(0, 100) });
  }

  // ── Change Management ───────────────────────────────────────────────────────

  /**
   * Execute a change request in background based on assessed scope.
   *
   * @param {string} projectRoot
   * @param {'small'|'medium'|'large'} scope — assessed by Claude in step 1
   * @param {string} description — the change description from user
   * @returns {string} immediate status message
   */
  startChange(projectRoot, scope, description) {
    if (this._phase) {
      return `⚠️ Phase "${this._phase}" is already running. Finish it first or *cancel.`;
    }

    this._projectRoot = projectRoot;
    this._phase = 'change';
    this._lastHash = '';
    this._stableCount = 0;

    log.engine(`Change management: scope=${scope}, desc="${description.slice(0, 60)}..."`);

    try {
      if (scope === 'small') {
        return this._executeSmallChange(projectRoot, description);
      } else if (scope === 'medium' || scope === 'large') {
        return this._executeMediumChange(projectRoot, scope, description);
      } else {
        this._phase = null;
        return `❌ Unknown scope: ${scope}. Expected small/medium/large.`;
      }
    } catch (err) {
      this._phase = null;
      return `❌ Change failed: ${err.message}`;
    }
  }

  /**
   * Small change: send *solo to Dev window in existing dev session.
   */
  _executeSmallChange(projectRoot, description) {
    const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
    const result = execSync(`bash "${scriptPath}" dev "${projectRoot}"`, { encoding: 'utf8', timeout: 60000 }).trim();
    const lines = result.split('\n');
    this._session = lines[lines.length - 1].trim();

    // Send to Dev window (window 2)
    tmx.sendKeysWithEnter(this._session, 2, '/clear');
    execSync('sleep 2');
    tmx.sendKeysWithEnter(this._session, 2, '/o dev');
    execSync('sleep 12');
    tmx.sendKeysWithEnter(this._session, 2, `*solo "${description}"`);

    // Poll for completion
    const pollInterval = this.config.phase_poll_interval || 30000;
    this._step = 0; // track which step we're on
    this._changeContext = { scope: 'small', description };
    this._timer = setInterval(() => this._pollChange(), pollInterval);

    return msg('change_small', { desc: description.slice(0, 100) });
  }

  /**
   * Medium/Large change: PO route-change in planning session, then apply in dev session.
   */
  _executeMediumChange(projectRoot, scope, description) {
    const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');

    // Step 1: Ensure planning session
    const planResult = execSync(`bash "${scriptPath}" planning "${projectRoot}"`, { encoding: 'utf8', timeout: 60000 }).trim();
    const planLines = planResult.split('\n');
    const planSession = planLines[planLines.length - 1].trim();

    // Step 2: Activate PO and route change
    tmx.sendKeysWithEnter(planSession, 0, '/o po');
    execSync('sleep 15');
    tmx.sendKeysWithEnter(planSession, 0, `*route-change "${description}"`);

    // Poll for PO completion, then chain to next agent
    const pollInterval = this.config.phase_poll_interval || 30000;
    this._step = 0;
    this._changeContext = {
      scope,
      description,
      planSession,
      // Steps: 0=PO route-change → 1=Architect/PM (based on PO output) → 2=SM apply-proposal
    };
    this._timer = setInterval(() => this._pollChange(), pollInterval);

    return msg('change_medium', { scope: scope === 'large' ? 'Large' : 'Medium', desc: description.slice(0, 100) });
  }

  /**
   * Poll change management progress.
   */
  _pollChange() {
    if (this._phase !== 'change') return;
    if (this._waitingForInput) return;

    const ctx = this._changeContext;
    if (!ctx) return;

    if (ctx.scope === 'small') {
      // Polling Dev window for completion
      if (!tmx.hasSession(this._session)) {
        this._handleError('change', 'Dev tmux session died');
        return;
      }
      const result = tmx.checkCompletion(this._session, 2, this._lastHash);
      if (result.status === 'complete' || (result.status === 'stable' && ++this._stableCount >= 3)) {
        this._completeChange('Dev completed the change.');
        return;
      }
      if (result.status !== 'stable') { this._stableCount = 0; this._lastHash = result.hash || ''; }
      else { this._lastHash = result.hash; }
      return;
    }

    // Medium/Large: multi-step
    if (!tmx.hasSession(ctx.planSession)) {
      this._handleError('change', 'Planning tmux session died');
      return;
    }

    const result = tmx.checkCompletion(ctx.planSession, 0, this._lastHash);

    if (result.status === 'complete' || (result.status === 'stable' && ++this._stableCount >= 3)) {
      this._stableCount = 0;
      this._lastHash = '';
      this._step++;

      if (this._step === 1) {
        // PO finished routing. Now send to Architect for *resolve-change
        this.onProgress('✅ PO routing complete. Sending to Architect...');
        tmx.sendKeysWithEnter(ctx.planSession, 0, '/clear');
        execSync('sleep 2');
        tmx.sendKeysWithEnter(ctx.planSession, 0, '/o architect');
        execSync('sleep 15');
        tmx.sendKeysWithEnter(ctx.planSession, 0, '*resolve-change');
      } else if (this._step === 2) {
        // Architect finished. Apply in dev session via SM
        this.onProgress('✅ Architect resolved. Applying change via SM...');
        try {
          const scriptPath = path.join(SKILL_DIR, 'scripts', 'ensure-session.sh');
          const devResult = execSync(`bash "${scriptPath}" dev "${this._projectRoot}"`, { encoding: 'utf8', timeout: 60000 }).trim();
          const devLines = devResult.split('\n');
          this._session = devLines[devLines.length - 1].trim();

          tmx.sendKeysWithEnter(this._session, 1, '/clear');
          execSync('sleep 2');
          tmx.sendKeysWithEnter(this._session, 1, '/o sm');
          execSync('sleep 12');
          tmx.sendKeysWithEnter(this._session, 1, '*draft');

          // Planning window 0 (Architect) is already stable — next 3 stable polls
          // will trigger step 3 → _completeChange → transition to dev monitoring.
        } catch (err) {
          this._handleError('change', `Failed to apply in dev session: ${err.message}`);
        }
      } else if (this._step >= 3) {
        this._completeChange('Change applied. SM started new stories from the change.');
      }
      return;
    }

    if (result.status !== 'stable') { this._stableCount = 0; this._lastHash = result.hash || ''; }
    else { this._lastHash = result.hash; }
  }

  _completeChange(summary) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    const scope = (this._changeContext && this._changeContext.scope) || 'small';

    log.engine(`Change management complete (scope=${scope}): ${summary}`);
    this.onComplete('change', `✅ Change management complete.\n\n${summary}`);

    // Only transition to dev monitoring for medium/large changes where SM *draft
    // started the dev cycle. Small/direct changes are single-agent tasks — done is done.
    if ((scope === 'medium' || scope === 'large') && this._session && tmx.hasSession(this._session)) {
      this._phase = 'develop';
      this._changeContext = null;
      this._devStartedAt = Date.now();
      this._lastReportTime = Date.now();
      this._lastActiveAgent = null;
      this._stableCount = 0;
      this._lastHash = '';
      const pollInterval = this.config.dev_poll_interval || 300000;
      this._timer = setInterval(() => this._pollDevSession(), pollInterval);
      log.engine(`Change → dev monitoring: session=${this._session}, poll every ${Math.round(pollInterval / 60000)}min`);
      this.onProgress(msg('monitoring_dev'));
    } else {
      this._phase = null;
      this._changeContext = null;
    }
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  _handleError(phase, message) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._phase = null;
    log.error(`Phase ${phase} error: ${message}`);

    // Sanitize internal details from user-facing message
    const cleanMsg = message
      .replace(/orchestrix-[\w-]+/g, 'dev session')
      .replace(/op-[\w-]+/g, 'planning session')
      .replace(/yuri-[\w-]+/g, 'dispatcher')
      .replace(/\/Users\/\S+/g, '')
      .replace(/tmux session/gi, 'agent session');

    const recovery = msg('error_recovery', { _sub: phase });
    this.onError(phase, `❌ ${cleanMsg}\n\n${recovery}`);
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
