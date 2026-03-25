# Phase 5: Deploy Project

**Command**: `*deploy`
**Purpose**: Present deployment options, execute the user's chosen deployment strategy, and verify the deployment is healthy.

---

## Prerequisites

- Phase 4 (Test) must be complete
- `.yuri/memory.yaml` must exist with `phase4_test: complete`

---

## Step 0: Load Memory and Validate

1. Read `.yuri/memory.yaml` — restore project context
2. Verify `lifecycle.phase_status.phase4_test == complete`
   - If not → "Phase 4 not complete. Run `*test` first."
3. Set `PROJECT_DIR` from `project.project_root`
4. If `phase5_deploy == in_progress` → resume from last step
5. If `phase5_deploy == complete` → show deployed URL, offer re-deploy

Update memory:
- `lifecycle.current_phase` → 5
- `lifecycle.phase_status.phase5_deploy` → "in_progress"
- Save immediately

---

## Step 1: Present Deployment Options

Read deployment options from `${CLAUDE_SKILL_DIR}/data/deployment-options.yaml` and present to user:

```
## 🚀 Deployment Options

### 🇨🇳 China Region

| # | Provider | Best For | Description |
|---|----------|----------|-------------|
| 1 | Sealos | Prototype / MVP | One-click container deployment, zero ops |
| 2 | Aliyun ECS + Docker Compose | Production | Full control with ECS instances |
| 3 | Vercel (CN-accessible) | Frontend / SSR | Static and SSR deployment |

### 🌍 Overseas

| # | Provider | Best For | Description |
|---|----------|----------|-------------|
| 4 | Vercel | Frontend / Full-stack (Next.js) | Zero-config deployment |
| 5 | Railway | Backend APIs | Simple container deployment |
| 6 | AWS / GCP | Enterprise scale | Full cloud infrastructure |

Select a number (1-6), or describe your deployment preference:
```

---

## Step 2: User Selects Strategy

Record the user's choice:
- `deployment.strategy` → selected option ID (e.g. `china-sealos`, `overseas-vercel`)
- Save memory immediately

---

## Step 3: Execute Deployment

Based on the selected strategy, generate and execute the necessary deployment configuration:

### Common steps for all strategies:

1. **Generate Dockerfile** (if not exists):
   - Analyze project tech stack from `project.tech_stack`
   - Create appropriate multi-stage Dockerfile

2. **Generate docker-compose.yml** (if applicable):
   - For strategies that use Docker Compose (e.g. `china-aliyun-ecs`)

3. **Generate CI/CD config** (if applicable):
   - Vercel: `vercel.json`
   - Railway: `railway.json`
   - AWS: basic deployment scripts

4. **Execute deployment commands**:
   - Run the appropriate deployment CLI commands
   - Handle authentication prompts

### Self-solve problems:

- Max 2 retries for any failed step
- Analyze error output and attempt fix
- Only ask user for:
  - **Credentials** (API keys, tokens)
  - **DNS configuration** (domain names, CNAME records)
  - **Environment secrets** (database URLs, API secrets)

---

## Step 4: Health Check and Report

1. Wait for deployment to complete
2. Run health check on the deployed URL:
```bash
curl -s -o /dev/null -w "%{http_code}" "$DEPLOYED_URL"
```

3. IF healthy (2xx response):

Save final state:
- `deployment.url` → deployed URL
- `deployment.status` → "healthy"
- `lifecycle.phase_status.phase5_deploy` → "complete"
- `lifecycle.current_step` → "phase5.complete"
- Write checkpoint → `.yuri/checkpoints/checkpoint-phase5.yaml`

Report:
```
## ✅ Deployment Complete!

| Item | Detail |
|------|--------|
| **URL** | {deployed_url} |
| **Strategy** | {strategy_name} |
| **Status** | ✅ Healthy |
| **Health Check** | HTTP {status_code} |

🎉 Your project is live! From idea to deployment — mission complete.

### What's Next?
- Monitor your application at the deployed URL
- Run `/yuri *change "{description}"` to handle new requirements
- Run `/yuri *status` to check project state at any time
```

4. IF unhealthy:
- Capture error details
- Attempt fix (max 2 retries)
- If still failing → report to user with diagnostics and ask for guidance
