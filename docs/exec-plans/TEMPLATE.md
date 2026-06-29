# Plan: [Short title]

> **For agents:** This is the canonical state file for [scope]. Read it before doing any work on this initiative. Update task checkboxes and the Decision Log as work lands. Do NOT rewrite Goal / Approach without raising it with the Owner.

**Status:** active | completed | abandoned
**Started:** YYYY-MM-DD
**Target completion:** YYYY-MM-DD
**Owner:** [team or person driving the work]
**Reviewer:** [person who signs off]
**Linear:** [optional — link to umbrella ticket if one exists]

---

## Goal

What this builds and why. Two or three sentences. Resist the urge to write a spec here — the plan is state, not requirements.

## Approach

How we're building it. Key sequencing decisions, why this order, dependencies between steps. If it's a multi-PR effort, a small table of PRs with risk levels works well.

---

## Tasks

Use checkbox lists. Each task should be small enough to land in one commit. Where the task creates code or runs commands, include the real code / real commands — no placeholders, no "TBD", no "see PR description for details". The plan is the agent's only context.

- [ ] **1.1 First concrete step.** Show files touched, code if any, command to run, expected output.
- [ ] **1.2 Next step.** Same standard.

Group tasks under sub-headings (`### PR-1 · branch-name`, `### Verification`, etc.) when the plan has natural phases.

## Done criteria

A short bulleted list of verifiable conditions that mean this plan can be closed. Each bullet should be something an agent or human can check in under a minute.

- [ ] Condition 1
- [ ] Condition 2

When all are checked: move this file from `active/` to `completed/`, rename to include the completion date, set `Status:` to `completed`.

---

## Decision Log

Append-only. Every meaningful decision gets a one-line entry prefixed with `YYYY-MM-DD · <name>.` Rationale matters — future agents read this to understand *why* the plan looks the way it does.

- **YYYY-MM-DD · Name.** Decision. Rationale.

## Open Questions

Things we deferred or genuinely don't know. Each entry should name the question, the options considered, and the current lean (if any). When answered, the entry moves into the Decision Log.

1. **Question.** Options. Current lean.

---

## How agents read this plan

1. **Read this whole file before touching code.** It is the single source of truth for this initiative. PR comments and Slack threads are not.
2. **Pick the lowest unchecked task** in the lowest-numbered open section. Do not skip ahead.
3. **Run the exact commands shown.** If a command fails, that's a real signal — stop and report, don't paper over it.
4. **Update the checkbox in this file** in the same commit as the work. State lives with the code.
5. **Add a Decision Log entry** for any deviation from the plan, prefixed `YYYY-MM-DD · <name>.`
6. **If something is genuinely unclear**, add to Open Questions and surface to the Owner. Do not guess on security- or correctness-critical paths.
