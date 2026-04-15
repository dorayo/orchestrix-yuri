# Final Step: Close Out — Memory Write-back Protocol

**Every task file MUST execute this step after all work is complete.**
Read this file and execute each sub-step sequentially.

---

## F.1 Reflect — Process Observations (every invocation)

1. Read `~/.yuri/inbox.jsonl`.
2. Filter entries where `processed` = `false`.
3. IF there are unprocessed entries:
   - FOR EACH entry:
     a. Read the target memory file indicated by the entry's `signal` type
        (see `data/observe-signals.yaml` for signal-to-target mapping).
     b. Analyze the raw observation and extract structured information.
     c. Write the structured information to the target memory file.
        - For `boss_preference`: update the relevant field in `~/.yuri/boss/preferences.yaml`.
        - For `boss_identity`: update the relevant field in `~/.yuri/boss/profile.yaml`.
        - For `priority_change`: update `~/.yuri/portfolio/priorities.yaml`.
        - For `tech_lesson`: append to `{project}/.yuri/knowledge/insights.md`.
        - For `correction`: update the file where the wrong assumption was stored.
        - For `emotion`: analyze and decide if it implies a preference change.
     d. Mark the inbox entry as `processed: true` by rewriting it.
4. IF there are no unprocessed entries: skip to F.1.5.

5. Update state files:
   - `{project}/.yuri/focus.yaml` → `pulse`, `step`, `action`, `updated_at`
   - `~/.yuri/focus.yaml` → `active_project`, `active_action`, `updated_at`
   - `~/.yuri/portfolio/registry.yaml` → current project's `pulse` field

---

## F.2 Phase Reflect — Extract Knowledge (only when a phase completes)

**Skip this section entirely if no phase was completed during this task.**

IF the current phase just transitioned to `complete`:

1. Read `{project}/.yuri/timeline/events.jsonl`.
   Filter events for the completed phase (match `phase` field).
2. Analyze events and extract:
   - **Decisions made + rationale** → append to `{project}/.yuri/knowledge/decisions.md`
   - **Problems encountered + solutions** → append to `{project}/.yuri/knowledge/insights.md`
   - **New domain concepts learned** → append to `{project}/.yuri/knowledge/domain.md`
3. Update `{project}/.yuri/focus.yaml` → advance `phase` to N+1, clear `step` and `action`.
4. Write checkpoint: copy current `{project}/.yuri/state/phase{N}.yaml`
   to `{project}/.yuri/checkpoints/phase{N}.yaml`.
5. Append event: `{"ts":"...","type":"phase_completed","phase":N}` to `timeline/events.jsonl`.

---

## F.3 Consolidate — Promote to Global Wisdom (only when a phase completes)

**Skip this section entirely if no phase was completed during this task.**

1. Read all files in `{project}/.yuri/knowledge/`.
2. For each insight or decision, evaluate: **Is this specific to this project, or universally applicable?**
   - Project-specific (e.g., "this project's API has a 3s timeout") → leave in project knowledge.
   - Universal (e.g., "Prisma ORM requires glibc, do not use Alpine images") → proceed to step 3.
3. For universal insights:
   - Read `~/.yuri/wisdom/tech.md` (or `workflow.md` / `pitfalls.md` as appropriate).
   - IF the insight already exists: strengthen it (add "Verified in project: {name}").
   - IF the insight is new: append it with `Source: {project.name}`.
4. Check `~/.yuri/boss/profile.yaml` and `~/.yuri/boss/preferences.yaml`:
   - Did this phase reveal new understanding about the user? Update if so.
5. Check `~/.yuri/portfolio/relationships.yaml`:
   - Did this phase reveal dependencies or synergies with other projects? Update if so.

---

## F.4 Decay — Prune Stale Memories (only when a phase completes)

**Skip this section entirely if no phase was completed during this task.**

1. **Wisdom decay**:
   - Read `~/.yuri/wisdom/tech.md`, `workflow.md`, `pitfalls.md`.
   - For each entry: check if it was referenced or relevant in the last 3 projects.
   - IF not referenced in 3 projects: mark as `[stale]`.
   - IF already marked `[stale]` from a previous Consolidation: move to `~/.yuri/wisdom/archive.md`.

2. **Preference decay**:
   - Read `~/.yuri/boss/preferences.yaml`.
   - For each preference: check if the user's recent behavior is consistent with it.
   - IF a preference has not been reinforced in 3+ months: mark as `[uncertain]`.
   - When encountering an `[uncertain]` preference in future tasks: ask the user to confirm before assuming.

3. **Portfolio cleanup**:
   - Read `~/.yuri/portfolio/registry.yaml`.
   - Projects with `status: paused` for > 30 days: suggest archiving to user.
   - Projects with `status: maintenance` and no timeline events for > 60 days:
     remove from `~/.yuri/focus.yaml` → `attention_queue`.

---

## F.5 Post-Ship Documentation & Retrospective (gstack — only after Phase 5 completes)

**Skip this section entirely unless Phase 5 (Deploy) just completed successfully.**

Check gstack availability first:
```bash
test -d "$HOME/.claude/skills/gstack" && echo "gstack_available" || echo "gstack_missing"
```

IF `gstack_missing` → skip F.5 entirely.

### F.5.1 Document Release (`/document-release`)

**Purpose**: Automatically sync project documentation with what actually shipped. READMEs, ARCHITECTURE.md, CONTRIBUTING.md, CHANGELOG, and CLAUDE.md are often stale by deployment time.

Execute:

```
/document-release
```

This reads all project docs, cross-references the diff since project start, and updates:
- README.md (features, setup instructions, API docs)
- ARCHITECTURE.md (if it exists — system design, data flows)
- CHANGELOG.md (polished voice, consistent format)
- Any other documentation that references changed code

Report:
```
📝 Documentation synced with shipped code.
Updated: {list of updated doc files}
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"document_release","files_updated":[{list}]}
```

### F.5.2 Engineering Retrospective (`/retro`)

**Purpose**: Generate a structured retrospective analyzing the full project lifecycle — commit patterns, code quality metrics, testing coverage, shipping velocity, and actionable improvements for the next project.

Execute:

```
/retro
```

This analyzes git history for the project and produces:
- **Velocity metrics**: commits, LOC, test-to-production ratio
- **Code quality signals**: test coverage trends, file hotspots, fix-to-feature ratio
- **Time patterns**: work sessions, peak hours, focus score
- **Top 3 wins**: highest-impact deliverables
- **3 improvements**: specific, actionable, anchored in data
- **3 habits for next project**: small, realistic practices

Parse the retro output and extract universal insights for wisdom:

**Promote to global wisdom** (if applicable):
- Patterns that would benefit future projects → `~/.yuri/wisdom/workflow.md`
- Technical gotchas discovered → `~/.yuri/wisdom/tech.md`
- Process pitfalls encountered → `~/.yuri/wisdom/pitfalls.md`

Report summary to user:
```
📊 Project Retrospective generated.
Key stats: {commits} commits, {loc} LOC, {test_ratio}% test coverage
Top win: {top_win}
Top improvement: {top_improvement}
```

Append to timeline:
```jsonl
{"ts":"{ISO-8601}","type":"retro_completed","commits":{n},"loc":{n},"test_ratio":{n}}
