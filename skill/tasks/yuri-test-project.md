# Phase 4: Test Project

**Command**: `*test`
**Purpose**: Run smoke tests per epic, fix bugs via Dev agent, and run regression tests until all epics pass.

---

## Prerequisites

- Phase 3 (Develop) must be complete.
- `{project}/.yuri/state/phase3.yaml` must have `status: complete`.

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

After Wake Up, validate:
1. Read `{project}/.yuri/state/phase3.yaml` → verify `status` = `complete`.
   - IF not → "Phase 3 not complete. Run `*develop` first." and stop.
2. Set `PROJECT_DIR` from `{project}/.yuri/identity.yaml` → `project.root`.
3. Collect epic list:
```bash
EPICS=$(ls "$PROJECT_DIR/docs/prd/epic-"*.yaml 2>/dev/null | sed 's/.*epic-//' | sed 's/\.yaml//')
```

**Resumption check:**
- IF `{project}/.yuri/state/phase4.yaml` exists with `status: in_progress`:
  → Find last untested epic → resume from there.
- IF `{project}/.yuri/state/phase4.yaml` exists with `status: complete`:
  → Offer to skip to Phase 5.
- OTHERWISE → initialize `state/phase4.yaml` from `$TEMPLATES_DIR/phase4.template.yaml`.

Update memory:
- `{project}/.yuri/focus.yaml` → `phase: 4`, `step: "testing"`, `action: "starting smoke tests"`, `updated_at: now`
- `{project}/.yuri/state/phase4.yaml` → `status: "in_progress"`, `started_at: now`
- Initialize `epics` array with all epic IDs, each `status: pending`.
- `~/.yuri/focus.yaml` → `active_action: "testing project: {name}"`, `updated_at: now`
- Append to `{project}/.yuri/timeline/events.jsonl`:
  ```jsonl
  {"ts":"{ISO-8601}","type":"phase_started","phase":4,"epic_count":{count}}
  ```
- Save all files immediately.

---

## Step 1: Ensure Dev Session + Reload QA Agent

```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
SESSION=$(bash "$SCRIPT_DIR/ensure-session.sh" dev "$PROJECT_DIR")
```

Reload QA agent in clean state:
```bash
tmux send-keys -t "$SESSION:3" "/clear"
sleep 1
tmux send-keys -t "$SESSION:3" Enter
sleep 2
tmux send-keys -t "$SESSION:3" "/o qa"
sleep 1
tmux send-keys -t "$SESSION:3" Enter
sleep 12
```

Update `{project}/.yuri/focus.yaml` → `tmux.dev_session: "$SESSION"`.

---

## Step 2: Smoke Test Each Epic

FOR EACH `EPIC_ID` in the epic list:

### 2.1 Run Smoke Test

```bash
tmux send-keys -t "$SESSION:3" "*smoke-test $EPIC_ID"
sleep 1
tmux send-keys -t "$SESSION:3" Enter
```

Monitor completion:
```bash
SCRIPT_DIR="${CLAUDE_SKILL_DIR}/scripts"
RESULT=$(bash "$SCRIPT_DIR/monitor-agent.sh" "$SESSION" 3 "" 30 30)
```

### 2.2 Evaluate Result

Capture QA output:
```bash
tmux capture-pane -t "$SESSION:3" -p -S -100
```

Parse for PASS/FAIL indicators.

### 2.3 Handle FAIL

IF test failed, extract bug descriptions from QA output. Then:

1. Reload Dev agent:
```bash
tmux send-keys -t "$SESSION:2" "/clear"
sleep 1
tmux send-keys -t "$SESSION:2" Enter
sleep 2
tmux send-keys -t "$SESSION:2" "/o dev"
sleep 1
tmux send-keys -t "$SESSION:2" Enter
sleep 12
```

2. Send quick-fix command:
```bash
tmux send-keys -t "$SESSION:2" "*quick-fix \"$BUG_DESC\""
sleep 1
tmux send-keys -t "$SESSION:2" Enter
```

3. Monitor Dev completion.
4. Retest: send `*smoke-test $EPIC_ID` to QA again.
5. Maximum 3 regression rounds per epic. IF still failing after 3 rounds:
   - Mark epic as `failed` in `state/phase4.yaml`.
   - Report to user with diagnostics.
   - Continue to next epic.

### 2.4 Handle PASS

Update `{project}/.yuri/state/phase4.yaml`:
```yaml
epics[n].status: passed
epics[n].rounds: {round_count}
epics[n].last_tested_at: "{ISO-8601}"
```

Append to `{project}/.yuri/timeline/events.jsonl`:
```jsonl
{"ts":"{ISO-8601}","type":"epic_tested","id":"{epic_id}","result":"passed","rounds":{n}}
```

Update `{project}/.yuri/focus.yaml`:
- `pulse` → "Phase 4: {passed}/{total} epics passed"
- `updated_at` → now

Update `~/.yuri/portfolio/registry.yaml` → this project's `pulse`.

Report:
```
✅ Epic {EPIC_ID} passed ({round_count} round(s))
```

### 2.5 Observe

Check if any signals occurred during testing (user feedback, tech lessons from bugs).
IF signal detected → append to `~/.yuri/inbox.jsonl`.

---

## Step 3: Browser QA (gstack — UI projects only)

**Purpose**: After code-level smoke tests pass, run real browser-based end-to-end testing to catch rendering bugs, JS runtime errors, broken interactions, and visual issues that unit/integration tests cannot detect.

### 3.0 Check preconditions

Skip this step entirely IF any of:
- gstack is not installed (`~/.claude/skills/gstack/` missing)
- Project has no UI (no frontend files, no `docs/front-end-spec*.md`)
- No dev server URL is available

```bash
HAS_GSTACK=$(test -d "$HOME/.claude/skills/gstack" && echo "yes" || echo "no")
HAS_UI=$(ls "$PROJECT_DIR/src/"*.{tsx,jsx,vue,svelte} "$PROJECT_DIR/app/"*.{tsx,jsx} 2>/dev/null | head -1)
```

IF skipping → report:
```
ℹ️ Browser QA skipped ({reason: no gstack / no UI / no dev server})
```
→ proceed to Step 4.

### 3.1 Run Browser QA

Report to user:
```
🌐 Running browser-based QA testing...
```

Execute in Yuri's own session:

```
/qa
```

This runs in **Standard** tier by default (systematic exploration of all pages, 5-10 issues).

Wait for completion. Parse for:
- **Health score** (0-100)
- **Issues found** (by severity: critical, high, medium, low)
- **Auto-fixed count** (gstack /qa fixes bugs and commits atomically)
- **Before/after screenshots**

### 3.2 Evaluate Browser QA Results

IF health score ≥ 80 AND no critical issues:
- Report:
  ```
  ✅ Browser QA passed (score: {score}/100, {fixed} issues auto-fixed)
  ```
- Proceed to Step 4.

IF health score < 80 OR critical issues found:
- Report:
  ```
  ⚠️ Browser QA found issues (score: {score}/100):
  - Critical: {n} | High: {n} | Medium: {n}
  - Auto-fixed: {n}
  - Remaining: {n}

  {list of unfixed critical/high issues with repro steps}

  Fix remaining / Accept and continue / Re-run QA?
  ```
  - **Fix remaining** → route unfixed bugs to Dev agent via `*quick-fix`, then re-run `/qa`.
  - **Accept** → proceed with warnings logged.
  - **Re-run** → execute `/qa` again.

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"browser_qa","score":{score},"issues":{total},"fixed":{fixed}}
```

Update `{project}/.yuri/state/phase4.yaml` → add `browser_qa` section:
```yaml
browser_qa:
  status: complete
  score: {score}
  issues: {total}
  fixed: {fixed}
```

---

## Step 4: All Testing Complete

1. Check results: count passed vs failed epics + browser QA status.

2. IF all epics passed (and browser QA passed or skipped):
   - `{project}/.yuri/state/phase4.yaml` → `status: "complete"`, `completed_at: now`
   - `{project}/.yuri/focus.yaml` → `step: "phase4.complete"`, `pulse: "Phase 4 complete, all epics passed"`
   - Append: `{"ts":"...","type":"phase_completed","phase":4}` to timeline.

3. IF some epics failed:
   - Report failed epics to user.
   - Ask: "Retry failed epics, skip to pre-ship, or pause?"
   - IF retry → re-enter Step 2 for failed epics only.
   - IF skip → mark phase complete with note about failures.
   - IF pause → save state, stop.

4. Route to Pre-Ship Quality Gate:
```
🚀 All tests passed! Next: Pre-Ship Quality Gate (code review + security + performance).
Run quality gates now? (Y / Skip to deploy)
```

- If Y → execute `tasks/yuri-pre-ship.md`
- If "Skip to deploy" → execute `tasks/yuri-deploy-project.md`
- If user wants to pause → save state, end with reminder: "Run `/yuri *pre-ship` or `/yuri *deploy` when ready."

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

Phase 4 completes in Step 3, so the Close Out will trigger F.1-F.4.
Testing phase often reveals technical insights (bug patterns, fragile areas) — Phase Reflect should capture these.
