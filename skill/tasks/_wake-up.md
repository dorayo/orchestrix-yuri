# Step 0: Wake Up — Memory Loading Protocol

**Every task file MUST execute this step before any work begins.**
Read this file and execute each sub-step sequentially.

---

## 0.1 Catch-up Check

1. Read `~/.yuri/focus.yaml`. Extract `updated_at`.
2. Compute `GAP` = current time minus `updated_at`.
3. IF `GAP` > 1 hour:
   - Read `~/.yuri/portfolio/registry.yaml`.
   - FOR EACH project WHERE `status` = `active`:
     a. Read `{project.root}/.yuri/focus.yaml` — check if `updated_at` changed externally.
     b. Run: `git -C "{project.root}" log --oneline --since="{updated_at}" -5` — detect manual commits.
     c. IF `focus.yaml` lists a tmux session name: run `tmux has-session -t "{session}" 2>/dev/null` — check alive.
     d. Update `~/.yuri/portfolio/registry.yaml` → this project's `pulse` field with latest state.
   - Write updated `~/.yuri/portfolio/registry.yaml`.

4. IF `GAP` > 24 hours (additional):
   - Read `~/.yuri/portfolio/priorities.yaml`. Flag any project with a deadline that has passed.
   - Read `~/.yuri/focus.yaml` → `pending_from_boss`. These items are still awaiting user decisions.

---

## 0.2 Load L1 — Global Context (mandatory, every invocation)

Read these 5 files. Hold their content in context for the duration of this task.

1. `~/.yuri/self.yaml` — Yuri identity
2. `~/.yuri/boss/profile.yaml` — user profile
3. `~/.yuri/boss/preferences.yaml` — user preferences
4. `~/.yuri/portfolio/registry.yaml` — all projects
5. `~/.yuri/focus.yaml` — current attention state

IF any file is missing: warn user to run `npx orchestrix-yuri install` and stop.

---

## 0.3 Load L2 — Project Context (conditional)

Determine the target project:
- IF the current working directory matches a `root` in `portfolio/registry.yaml`: use that project.
- IF the user's message names a specific project: use that project.
- IF `~/.yuri/focus.yaml` → `active_project` is set and no other project is indicated: use that.
- IF no project can be determined and this task requires one: ask the user which project.

Once the target project is identified, read:

1. `{project}/.yuri/identity.yaml` — project identity
2. `{project}/.yuri/focus.yaml` — project operational state
3. `{project}/.yuri/state/phase{N}.yaml` — current phase state (where N = `focus.yaml` → `phase`)

Optionally (if the task involves decision-making or change management):
4. `{project}/.yuri/knowledge/decisions.md`
5. `{project}/.yuri/knowledge/insights.md`
6. `~/.yuri/wisdom/tech.md`
7. `~/.yuri/portfolio/relationships.yaml`

---

## 0.4 Update Focus

After loading, immediately update:
- `~/.yuri/focus.yaml` → `active_project` = current project id, `updated_at` = now
- `{project}/.yuri/focus.yaml` → `updated_at` = now

This marks that Yuri is now active and working on this project.
