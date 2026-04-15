# Phase 5: Deploy Project

**Command**: `*deploy`
**Purpose**: Recommend and execute a deployment strategy based on project requirements and user preferences.

---

## Prerequisites

- Phase 4 (Test) must be complete.
- `{project}/.yuri/state/phase4.yaml` must have `status: complete`.
- Pre-Ship Quality Gate should be complete (recommended but not required).
  - IF `{project}/.yuri/state/pre-ship.yaml` exists with `status: complete` → proceed.
  - IF not → warn: "Pre-ship quality gates were not run. Consider running `*pre-ship` first." → ask user to continue or run pre-ship.

---

## Step 0: Wake Up

Read [_wake-up.md](tasks/_wake-up.md) and execute it fully.

After Wake Up, validate:
1. Read `{project}/.yuri/state/phase4.yaml` → verify `status` = `complete`.
   - IF not → "Phase 4 not complete. Run `*test` first." and stop.
2. Set `PROJECT_DIR` from `{project}/.yuri/identity.yaml` → `project.root`.

**Resumption check:**
- IF `{project}/.yuri/state/phase5.yaml` exists with `status: in_progress`:
  → Resume from last saved step.
- IF `{project}/.yuri/state/phase5.yaml` exists with `status: complete`:
  → Show deployment info, offer re-deploy.
- OTHERWISE → initialize `state/phase5.yaml` from `$TEMPLATES_DIR/phase5.template.yaml`.

Update memory:
- `{project}/.yuri/focus.yaml` → `phase: 5`, `step: "deploying"`, `action: "selecting deployment strategy"`, `updated_at: now`
- `{project}/.yuri/state/phase5.yaml` → `status: "in_progress"`, `started_at: now`
- `~/.yuri/focus.yaml` → `active_action: "deploying project: {name}"`, `updated_at: now`
- Append to `{project}/.yuri/timeline/events.jsonl`:
  ```jsonl
  {"ts":"{ISO-8601}","type":"phase_started","phase":5}
  ```
- Save all files immediately.

---

## Step 1: Present Deployment Options

Read deployment options from `${CLAUDE_SKILL_DIR}/data/deployment-options.yaml`.

Also check:
- `~/.yuri/boss/preferences.yaml` → `workflow.deploy_region` (user's preferred region).
- `~/.yuri/wisdom/tech.md` → any deployment-related insights from past projects.
- `{project}/.yuri/knowledge/decisions.md` → any deployment-related decisions already made.

Present options with a recommendation based on available context:

```
## 🚀 Deployment Options

| # | Provider | Region | Best For | Recommended? |
|---|----------|--------|----------|-------------|
{deployment options table}

Based on {reasoning}, I recommend **{option}**.

Select a number, or describe your deployment requirements:
```

---

## Step 2: User Selects Strategy

Record the user's choice:
- `{project}/.yuri/state/phase5.yaml` → `strategy: "{option_id}"`
- `{project}/.yuri/knowledge/decisions.md` → append deployment decision with rationale.
- Save immediately.

---

## Step 3: Execute Deployment

Based on the selected strategy, generate deployment artifacts:

1. **Dockerfile** (if container-based strategy)
2. **docker-compose.yaml** (if applicable)
3. **CI/CD pipeline** (GitHub Actions workflow)
4. **Platform-specific config** (e.g., `railway.toml`, `vercel.json`, `sealos.yaml`)

Execute the deployment process according to the selected provider's requirements.

Update `{project}/.yuri/focus.yaml` → `action: "executing deployment via {strategy}"`.

---

## Step 4: Post-Deploy Verification

After deployment completes, set:
```bash
DEPLOYED_URL="{url from deployment output}"
```

### 4.1 Quick Health Check (immediate)

First, do a fast HTTP check to confirm the deployment succeeded at all:

```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$DEPLOYED_URL" 2>/dev/null)
```

IF `HTTP_CODE` != 200 → deployment itself failed:
- Report error to user with diagnostics.
- Offer: retry, try alternative strategy, or pause.
- Do NOT proceed to canary monitoring.

### 4.2 Canary Monitoring (gstack — 10 minutes)

IF quick health check passed AND gstack is available:

```bash
test -d "$HOME/.claude/skills/gstack" && echo "gstack_available" || echo "gstack_missing"
```

**IF gstack available:**

Report to user:
```
✅ Deployment succeeded (HTTP 200). Starting 10-minute canary monitoring...
```

Step 1 — Capture baseline (if pre-ship `/benchmark` was run, this is already done):
```
/canary {DEPLOYED_URL} --baseline
```

Step 2 — Start canary monitoring:
```
/canary {DEPLOYED_URL}
```

This monitors for 10 minutes, checking every 60 seconds:
- Page load failures or timeouts
- New console errors not in baseline
- Performance regressions (load times 2x slower than baseline)
- Broken links

Wait for canary to complete. Parse results:
- **Health status**: HEALTHY / DEGRADED / BROKEN
- **Alert count**
- **Rollback recommendation** (if any)

IF canary reports **HEALTHY**:
- Proceed to success state (Step 4.3).

IF canary reports **DEGRADED**:
- Report issues to user with screenshot evidence:
  ```
  ⚠️ Canary detected issues during monitoring:
  {list of alerts with evidence}

  The deployment is functional but has issues. Continue / Rollback?
  ```
  - IF continue → proceed to Step 4.3 with warnings logged.
  - IF rollback → offer rollback guidance, pause.

IF canary reports **BROKEN**:
- Report critical failure:
  ```
  🚨 Canary detected critical failures:
  {alerts with screenshots}

  Recommend immediate rollback. Rollback / Investigate / Keep?
  ```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"canary_completed","url":"{url}","health":"{status}","alerts":{count}}
```

**IF gstack NOT available** — fall back to basic check:
- The HTTP 200 check from 4.1 is sufficient. Proceed to Step 4.3.
- Note in timeline: `"canary":"skipped_no_gstack"`

### 4.3 Mark Complete

- `{project}/.yuri/state/phase5.yaml` → `status: "complete"`, `completed_at: now`, `url: "$DEPLOYED_URL"`, `health: "{canary_status or 'healthy'}"`, `canary_alerts: {count or 0}`
- `{project}/.yuri/focus.yaml` → `step: "phase5.complete"`, `pulse: "Deployed and {health} at {url}"`
- Append to timeline:
  ```jsonl
  {"ts":"{ISO-8601}","type":"project_deployed","url":"{url}","strategy":"{strategy}","health":"{status}","canary_alerts":{count}}
  {"ts":"{ISO-8601}","type":"phase_completed","phase":5}
  ```
- Update `~/.yuri/portfolio/registry.yaml` → this project's `status: maintenance`, `pulse: "v1.0 deployed at {url}"`

Report:
```
## ✅ Deployment Complete

| Item | Detail |
|------|--------|
| **Strategy** | {strategy} |
| **URL** | {url} |
| **Health** | {✅ Healthy / ⚠️ Degraded} |
| **Canary** | {10 min monitoring: N alerts / skipped} |

🎉 Project lifecycle complete! From idea to production.

The project is now in maintenance mode. Use `/yuri *change` for future updates,
or `/yuri *status` to check on all your projects.
```

---

## Final Step: Close Out

Read [_close-out.md](tasks/_close-out.md) and execute it fully.

**Phase 5 is the last phase. Consolidation here is especially important.**

The Close Out will trigger:
- F.1 Reflect (process all remaining inbox observations)
- F.2 Phase Reflect (review deployment timeline — capture deployment decisions and any issues)
- F.3 Consolidate (**FULL project review**):
  - Review ALL project knowledge (decisions.md, insights.md, domain.md)
  - Promote universal insights to global wisdom
  - This is the most thorough Consolidation — the project lifecycle is complete
  - Pay special attention to: deployment patterns, CI/CD lessons, monitoring setup
- F.4 Decay (standard checks)
