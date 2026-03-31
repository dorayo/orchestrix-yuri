'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Test command pattern matching directly from the router module source
// We can't easily import the constants, so we replicate them here
// and verify they match the expected inputs.

const PHASE_COMMANDS = {
  plan:     /^\*plan\b/i,
  develop:  /^\*develop\b/i,
  test:     /^\*test\b/i,
  change:   /^\*change\s+(.+)/i,
  iterate:  /^\*iterate\b/i,
  deploy:   /^\*deploy\b/i,
  cancel:   /^\*cancel\b/i,
};

const META_COMMANDS = {
  help:     /^\*help\b/i,
  projects: /^\*projects\b/i,
  switch:   /^\*switch\s+(.+)/i,
};

const STATUS_PATTERNS = [
  /^\*status\b/i,
  /进度|状态|怎么样了|到哪了/,
  /\bstatus\b|\bprogress\b/i,
];

function matchPhase(text) {
  for (const [phase, re] of Object.entries(PHASE_COMMANDS)) {
    if (phase === 'cancel') continue;
    if (re.test(text.trim())) return phase;
  }
  return null;
}

function matchMeta(text) {
  for (const [cmd, re] of Object.entries(META_COMMANDS)) {
    if (re.test(text.trim())) return cmd;
  }
  return null;
}

function matchStatus(text) {
  return STATUS_PATTERNS.some((re) => re.test(text.trim()));
}

// ── Phase Commands ─────────────────────────────────────────────────────────────

describe('Phase Command Matching', () => {
  it('*plan matches', () => assert.equal(matchPhase('*plan'), 'plan'));
  it('*plan (uppercase)', () => assert.equal(matchPhase('*PLAN'), 'plan'));
  it('*develop matches', () => assert.equal(matchPhase('*develop'), 'develop'));
  it('*test matches', () => assert.equal(matchPhase('*test'), 'test'));
  it('*deploy matches', () => assert.equal(matchPhase('*deploy'), 'deploy'));
  it('*iterate matches', () => assert.equal(matchPhase('*iterate'), 'iterate'));

  it('*change with description', () => {
    assert.equal(matchPhase('*change "add dark mode"'), 'change');
  });
  it('*change extracts description', () => {
    const m = '*change add dark mode toggle'.match(PHASE_COMMANDS.change);
    assert.ok(m);
    assert.equal(m[1], 'add dark mode toggle');
  });
  it('*change without description does NOT match', () => {
    assert.equal(matchPhase('*change'), null);
  });

  it('*cancel matches', () => assert.ok(PHASE_COMMANDS.cancel.test('*cancel')));

  // Should NOT match
  it('plain text does not match', () => assert.equal(matchPhase('hello'), null));
  it('*create does not match phase commands', () => assert.equal(matchPhase('*create'), null));
  it('partial *plan text does not match', () => assert.equal(matchPhase('*planning'), null));
});

// ── Meta Commands ──────────────────────────────────────────────────────────────

describe('Meta Command Matching', () => {
  it('*help matches', () => assert.equal(matchMeta('*help'), 'help'));
  it('*projects matches', () => assert.equal(matchMeta('*projects'), 'projects'));

  it('*switch with name', () => {
    assert.equal(matchMeta('*switch myproject'), 'switch');
  });
  it('*switch extracts project name', () => {
    const m = '*switch my-blog'.match(META_COMMANDS.switch);
    assert.ok(m);
    assert.equal(m[1], 'my-blog');
  });
  it('*switch without name does NOT match', () => {
    assert.equal(matchMeta('*switch'), null);
  });

  it('plain text does not match', () => assert.equal(matchMeta('hello'), null));
});

// ── Status Patterns ────────────────────────────────────────────────────────────

describe('Status Pattern Matching', () => {
  it('*status matches', () => assert.ok(matchStatus('*status')));
  it('*STATUS matches', () => assert.ok(matchStatus('*STATUS')));
  it('"进度" matches', () => assert.ok(matchStatus('进度怎么样')));
  it('"状态" matches', () => assert.ok(matchStatus('看看状态')));
  it('"怎么样了" matches', () => assert.ok(matchStatus('怎么样了')));
  it('"到哪了" matches', () => assert.ok(matchStatus('到哪了')));
  it('"what is the status" matches', () => assert.ok(matchStatus('what is the status')));
  it('"progress" matches', () => assert.ok(matchStatus('show me the progress')));

  it('unrelated text does NOT match', () => assert.ok(!matchStatus('hello yuri')));
  it('"stop" does NOT match status', () => assert.ok(!matchStatus('stop development')));
});

// ── Help Text ──────────────────────────────────────────────────────────────────

describe('Help Text Completeness', () => {
  // We can't call _buildHelpText directly without instantiating Router,
  // but we can verify the Router class exists and has the method.
  const { Router } = require('../lib/gateway/router');

  it('Router has _buildHelpText method', () => {
    assert.ok(typeof Router.prototype._buildHelpText === 'function');
  });

  // Verify all 12 commands are documented by checking the method source
  it('help text includes all commands', () => {
    const src = Router.prototype._buildHelpText.toString();
    const commands = ['*create', '*plan', '*develop', '*test', '*deploy',
      '*change', '*iterate', '*status', '*cancel', '*resume',
      '*projects', '*switch', '*help'];
    for (const cmd of commands) {
      assert.ok(src.includes(cmd), `Help text should include ${cmd}`);
    }
  });
});

// ── Phase Orchestrator Methods ─────────────────────────────────────────────────

describe('PhaseOrchestrator API', () => {
  const { PhaseOrchestrator } = require('../lib/gateway/engine/phase-orchestrator');

  it('has startPlan method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.startPlan === 'function');
  });
  it('has startDevelop method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.startDevelop === 'function');
  });
  it('has startTest method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.startTest === 'function');
  });
  it('has startChange method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.startChange === 'function');
  });
  it('has startIterate method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.startIterate === 'function');
  });
  it('has cancel method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.cancel === 'function');
  });
  it('has getStatus method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.getStatus === 'function');
  });
  it('has captureCurrentAgentContext method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.captureCurrentAgentContext === 'function');
  });
  it('has relayUserInput method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.relayUserInput === 'function');
  });
  it('has tryRecover method', () => {
    assert.ok(typeof PhaseOrchestrator.prototype.tryRecover === 'function');
  });

  it('getStatus returns "No phase" when idle', () => {
    const o = new PhaseOrchestrator({});
    const s = o.getStatus();
    assert.equal(s.phase, null);
    assert.ok(s.message.includes('No phase'));
  });

  it('isRunning returns false when idle', () => {
    const o = new PhaseOrchestrator({});
    assert.equal(o.isRunning(), false);
  });

  it('isWaitingForInput returns false when idle', () => {
    const o = new PhaseOrchestrator({});
    assert.equal(o.isWaitingForInput(), false);
  });

  it('cancel does not throw when idle', () => {
    const o = new PhaseOrchestrator({});
    o.cancel(); // should not throw
  });

  it('startPlan rejects when already running', () => {
    const o = new PhaseOrchestrator({});
    o._phase = 'plan';
    const result = o.startPlan('/tmp');
    assert.ok(result.includes('already running'));
    o._phase = null;
  });

  it('startChange rejects unknown scope', () => {
    const o = new PhaseOrchestrator({});
    const result = o.startChange('/tmp', 'huge', 'test');
    assert.ok(result.includes('Unknown scope'));
  });

  it('startChange rejects when already running', () => {
    const o = new PhaseOrchestrator({});
    o._phase = 'develop';
    const result = o.startChange('/tmp', 'small', 'test');
    assert.ok(result.includes('already running'));
    o._phase = null;
  });
});

// ── Slash to Star Conversion ───────────────────────────────────────────────────

describe('Slash to Star Conversion', () => {
  // Replicate the conversion logic from router.js
  function convert(text) {
    if (text.startsWith('/') && !text.startsWith('/start') && !text.startsWith('/o') && !text.startsWith('/clear')) {
      return '*' + text.slice(1);
    }
    return text;
  }

  // Should convert
  it('/status → *status', () => assert.equal(convert('/status'), '*status'));
  it('/help → *help', () => assert.equal(convert('/help'), '*help'));
  it('/plan → *plan', () => assert.equal(convert('/plan'), '*plan'));
  it('/develop → *develop', () => assert.equal(convert('/develop'), '*develop'));
  it('/test → *test', () => assert.equal(convert('/test'), '*test'));
  it('/deploy → *deploy', () => assert.equal(convert('/deploy'), '*deploy'));
  it('/iterate → *iterate', () => assert.equal(convert('/iterate'), '*iterate'));
  it('/cancel → *cancel', () => assert.equal(convert('/cancel'), '*cancel'));
  it('/projects → *projects', () => assert.equal(convert('/projects'), '*projects'));
  it('/switch myapp → *switch myapp', () => assert.equal(convert('/switch myapp'), '*switch myapp'));
  it('/change "desc" → *change "desc"', () => assert.equal(convert('/change "add feature"'), '*change "add feature"'));

  // Should NOT convert
  it('/start stays /start', () => assert.equal(convert('/start'), '/start'));
  it('/o dev stays /o dev', () => assert.equal(convert('/o dev'), '/o dev'));
  it('/clear stays /clear', () => assert.equal(convert('/clear'), '/clear'));
  it('*status stays *status', () => assert.equal(convert('*status'), '*status'));
  it('plain text stays', () => assert.equal(convert('hello'), 'hello'));

  // After conversion, should match commands
  it('/status converts and matches status pattern', () => {
    const converted = convert('/status');
    assert.ok(matchStatus(converted));
  });
  it('/help converts and matches meta command', () => {
    const converted = convert('/help');
    assert.equal(matchMeta(converted), 'help');
  });
  it('/plan converts and matches phase command', () => {
    const converted = convert('/plan');
    assert.equal(matchPhase(converted), 'plan');
  });
});
