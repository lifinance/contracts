---
name: Context window monitoring
description: Monitor context usage, warn when approaching limits, and handle information rollover
globs:
  - '**/*'
alwaysApply: true
---

- **Context monitoring**: Track approximate token usage; when context appears >80% full, explicitly warn the user: "⚠️ Context window approaching limit (~X% full). Consider: (1) Summarizing current task state, (2) Starting a fresh session, or (3) Continuing with reduced context."
- **Context transitions**: When context resets or appears truncated, immediately restate: (1) Active rules (compact tags), (2) Current task scope, (3) Any critical constraints or decisions made.
- **Handoff summary format**: When context is approaching limits or user requests a fresh session, create a concise handoff document with:
  - **Active rules**: List of rule tags currently in scope (e.g., `000-global-standards`, `102-facets`, `105-security`)
  - **Task state**: What was being worked on, current status, next steps
  - **Key decisions**: Any architectural choices, tradeoffs, or constraints established
  - **Files modified**: List of files changed (with brief notes on why)
  - **Tests/lints status**: What was run, what remains
  - **Open questions**: Any unresolved issues or assumptions
- **Rollover trigger**: Offer handoff summary when: (1) Context >80% full, (2) User explicitly requests, (3) Task spans multiple sessions, (4) Major context reset detected.
- **Fresh session startup**: When starting with a handoff summary, immediately: (1) Load relevant rules, (2) Confirm understanding of task state, (3) Verify any assumptions with user if needed.
