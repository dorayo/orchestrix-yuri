# Phase 4.5: Pre-Ship Quality Gate

**Command**: `*pre-ship`
**Purpose**: Run comprehensive quality checks (code review, security audit, performance baseline, design audit) before deployment. Uses gstack skills as independent quality gates.

---

## Prerequisites

- Phase 4 (Test) must be complete.
- `{project}/.yuri/state/phase4.yaml` must have `status: complete`.
- gstack must be installed (`~/.claude/skills/gstack/` must exist).

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

After Wake Up, validate:
1. Read `{project}/.yuri/state/phase4.yaml` → verify `status` = `complete`.
   - IF not → "Phase 4 not complete. Run `*test` first." and stop.
2. Set `PROJECT_DIR` from `{project}/.yuri/identity.yaml` → `project.root`.
3. Check gstack availability:
```bash
test -d "$HOME/.claude/skills/gstack" && echo "gstack_available" || echo "gstack_missing"
```
   - IF `gstack_missing` → warn user: "gstack not installed. Install with: `git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup`". Offer to skip pre-ship and go directly to deploy.

**Resumption check:**
- IF `{project}/.yuri/state/pre-ship.yaml` exists with `status: in_progress`:
  → Find last completed gate → resume from the next one.
- IF `{project}/.yuri/state/pre-ship.yaml` exists with `status: complete`:
  → Offer to skip to Phase 5.
- OTHERWISE → initialize `state/pre-ship.yaml`:
  ```yaml
  status: pending
  started_at: ""
  completed_at: ""
  gates:
    code_review:
      status: pending
      score: null
      findings: 0
      critical: 0
    security_audit:
      status: pending
      score: null
      findings: 0
      critical: 0
    performance_baseline:
      status: pending
      captured: false
    design_audit:
      status: pending
      score: null
      has_ui: null
  overall_verdict: pending
  ```

Update memory:
- `{project}/.yuri/focus.yaml` → `phase: 4.5`, `step: "pre-ship"`, `action: "running quality gates"`, `updated_at: now`
- `{project}/.yuri/state/pre-ship.yaml` → `status: "in_progress"`, `started_at: now`
- `~/.yuri/focus.yaml` → `active_action: "pre-ship quality gates: {name}"`, `updated_at: now`
- Append to `{project}/.yuri/timeline/events.jsonl`:
  ```jsonl
  {"ts":"{ISO-8601}","type":"pre_ship_started","gates":["code_review","security_audit","performance_baseline","design_audit"]}
  ```
- Save all files immediately.

---

## Step 1: Code Review Gate (`/review`)

**Purpose**: Catch structural issues that tests miss — SQL safety, race conditions, LLM trust boundaries, type coercion, async mixing, documentation staleness.

Report to user:
```
🔍 Gate 1/4: Code Review — scanning diff against base branch...
```

Execute in the current Claude Code session (Yuri's own session, NOT a tmux agent window):

```
/review
```

Wait for `/review` to complete. Parse the output for:
- **PR Quality Score** (0-10)
- **Critical findings** (severity ≥ 8)
- **Total findings count**
- **Auto-fixed items**

Update `{project}/.yuri/state/pre-ship.yaml`:
```yaml
gates.code_review:
  status: complete
  score: {pr_quality_score}
  findings: {total_findings}
  critical: {critical_count}
  completed_at: "{ISO-8601}"
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"gate_completed","gate":"code_review","score":{score},"findings":{findings},"critical":{critical}}
```

### Gate Decision

- IF `critical` = 0 → **PASS** — continue to next gate.
- IF `critical` > 0 AND all were auto-fixed → **PASS with fixes** — continue.
- IF `critical` > 0 AND some unfixed → **BLOCK** — report to user:
  ```
  ⚠️ Code Review found {critical} critical issue(s) requiring attention:
  {list of unfixed critical findings}

  Fix now / Skip / Abort pre-ship?
  ```
  - **Fix now** → user or Dev agent fixes, then re-run `/review`.
  - **Skip** → proceed with warning logged.
  - **Abort** → save state, stop.

---

## Step 2: Security Audit Gate (`/cso`)

**Purpose**: Detect exploitable vulnerabilities — secrets in git history, dependency supply chain, OWASP Top 10, CI/CD exposure, LLM/AI security risks.

Report to user:
```
🛡️ Gate 2/4: Security Audit — scanning for vulnerabilities...
```

Execute:

```
/cso
```

This runs in **daily mode** (default: 8/10 confidence gate, zero-noise).

Wait for completion. Parse for:
- **Security posture** (findings count, severity distribution)
- **Critical/High findings** (confidence ≥ 8)
- **Attack surface census**

Update `{project}/.yuri/state/pre-ship.yaml`:
```yaml
gates.security_audit:
  status: complete
  findings: {total}
  critical: {critical_high_count}
  completed_at: "{ISO-8601}"
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"gate_completed","gate":"security_audit","findings":{findings},"critical":{critical}}
```

### Gate Decision

- IF `critical` = 0 → **PASS**.
- IF `critical` > 0 → **BLOCK** — report with exploit scenarios:
  ```
  🚨 Security Audit found {critical} exploitable issue(s):
  {list with severity, file:line, exploit scenario}

  Fix now / Skip (accept risk) / Abort?
  ```
  - **Fix now** → address findings, re-run `/cso`.
  - **Skip** → proceed with risk accepted, log to `knowledge/decisions.md`.
  - **Abort** → save state, stop.

---

## Step 3: Performance Baseline Gate (`/benchmark`)

**Purpose**: Capture performance baseline metrics before deployment. These become the reference for post-deploy canary comparison.

Report to user:
```
📊 Gate 3/4: Performance Baseline — capturing metrics...
```

**Precondition**: Project must have a running dev server URL. Check:
1. Read `{project}/.orchestrix-core/core-config.yaml` for `dev_server_url`.
2. IF no dev server URL configured:
   - Try common patterns: `http://localhost:3000`, `http://localhost:5173`, `http://localhost:8080`.
   - IF none respond → skip this gate with note: "No dev server detected. Performance baseline skipped."
   - Update gate status to `skipped` and continue.

IF dev server is available:

```
/benchmark --baseline
```

Wait for completion. Parse for:
- **Core Web Vitals** (TTFB, FCP, LCP)
- **Bundle sizes** (JS, CSS)
- **Resource counts**

Update `{project}/.yuri/state/pre-ship.yaml`:
```yaml
gates.performance_baseline:
  status: complete
  captured: true
  dev_server_url: "{url}"
  completed_at: "{ISO-8601}"
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"gate_completed","gate":"performance_baseline","captured":true}
```

This gate does NOT block — it only captures baseline for later comparison.

---

## Step 4: Design Audit Gate (`/design-review`)

**Purpose**: Catch visual inconsistencies, AI slop patterns, spacing issues, hierarchy problems before users see them.

**Precondition**: Project must have UI components. Check:
1. Look for frontend files: `src/**/*.{tsx,jsx,vue,svelte}`, `app/**/*.{tsx,jsx}`, `pages/**/*.{tsx,jsx}`.
2. Check `{project}/.yuri/identity.yaml` → `stack` field for frontend frameworks.
3. IF no UI detected → skip this gate:
   ```
   ℹ️ Gate 4/4: Design Audit — skipped (no UI components detected)
   ```
   Update gate status to `skipped` and continue.

IF UI is present AND dev server is available:

Report to user:
```
🎨 Gate 4/4: Design Audit — reviewing visual quality...
```

```
/design-review quick
```

Wait for completion. Parse for:
- **Design score** (A-F)
- **AI Slop score** (A-F)
- **Per-category grades**
- **Critical visual issues**

Update `{project}/.yuri/state/pre-ship.yaml`:
```yaml
gates.design_audit:
  status: complete
  score: "{design_grade}"
  has_ui: true
  completed_at: "{ISO-8601}"
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"gate_completed","gate":"design_audit","score":"{grade}"}
```

### Gate Decision

- IF design score ≥ C → **PASS**.
- IF design score < C → **WARN** — report issues but do not block:
  ```
  ⚠️ Design audit scored {grade}. Key issues:
  {list of top issues}

  These are non-blocking but recommended to fix before launch.
  Continue to deploy / Fix first?
  ```

---

## Step 5: Quality Gate Summary

Compile results from all gates:

```
## 🏁 Pre-Ship Quality Gate Report

| Gate | Status | Score | Findings | Critical |
|------|--------|-------|----------|----------|
| Code Review | {✅/⚠️/❌} | {score}/10 | {n} | {n} |
| Security Audit | {✅/⚠️/❌} | — | {n} | {n} |
| Performance Baseline | {✅/⏭️} | — | captured | — |
| Design Audit | {✅/⚠️/⏭️} | {grade} | {n} | — |

**Overall**: {PASS / PASS WITH WARNINGS / BLOCKED}
```

### Overall Verdict Logic

- **All gates PASS** → `overall_verdict: pass`
- **Any gate WARN but no BLOCK** → `overall_verdict: pass_with_warnings`
- **Any gate BLOCK** → `overall_verdict: blocked` (should not reach here — blocks are handled per-gate)

Update `{project}/.yuri/state/pre-ship.yaml`:
```yaml
status: complete
completed_at: "{ISO-8601}"
overall_verdict: "{verdict}"
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"pre_ship_completed","verdict":"{verdict}"}
```

Update focus:
- `{project}/.yuri/focus.yaml` → `step: "pre-ship.complete"`, `pulse: "Pre-ship {verdict}, ready for deploy"`

### Transition

```
🚀 Pre-ship quality gates complete. Ready to deploy? (Y/N)
```

- If Y → execute `tasks/yuri-deploy-project.md`
- If N → save state, end with reminder: "Run `/yuri *deploy` when ready."

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

Pre-ship often reveals security patterns and code quality insights — Phase Reflect should capture these for project knowledge.
