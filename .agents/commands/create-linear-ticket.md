---
name: create-linear-ticket
description: 'Creates an EXSC Linear ticket, or repairs an existing one, so it always has an assignee, an estimate and a cycle, plus the InCursu label when it joins a running cycle. Writes a scannable title and a self-contained body with binary Done-when criteria and collapsible Agent notes, then challenges the draft against the code (claims hold, references exist, simpler or safer option) before saving. Use for "create a ticket", "open a Linear issue for X", "fix the ticket metadata on EXSC-123", or when another skill needs a ticket (create-pr).'
---

# Create Linear Ticket

## Inputs

- **What the ticket is for**: conversation context, a pasted draft, a Slack thread, or a diff (when called from `/create-pr`).
- **Existing ticket ID** (optional): repair mode. Skip steps 1–4; apply steps 5–8 to that ticket and never rewrite its title or body. Run step 4 only when the user asks for it.
- **Factory job**: if the ticket is meant for the AI Factory, hand off to `/factory-ticket` instead — it owns that template and the intake gate. Then run repair mode on the result.
- **Scope shape**: when the request says migrate, replace, move, consolidate or refactor, ask once whether it is a swap (old data abandoned), a migration (data preserved), a new feature, or an internal refactor. Hold the draft and step 4 to that shape; it keeps a swap from growing phases, flags or dual paths.

## Required fields

Sprint reporting counts only tickets that are assigned, estimated and in a cycle, so a ticket missing any of them is invisible to planning. `InCursu` marks scope added to a sprint after it started, which separates planned work from unplanned work in the retro. Apply these by that intent when a case below doesn't fit.

| Field           | Value                                                     |
| --------------- | --------------------------------------------------------- |
| `team`          | `SmartContract` (EXSC)                                    |
| `assignee`      | `"me"`; ask before reassigning a ticket someone else owns |
| `estimate`      | proposed in step 5, confirmed by the user                 |
| `cycle`         | resolved in step 6                                        |
| `InCursu` label | added when step 6 says so                                 |

## 1. Check for duplicates

`list_issues` with `team: "SmartContract"` and `query` set to 2–3 distinctive title keywords. No `assignee` filter. If an open ticket covers the same outcome, show the top 3 as `ID — title — status` and ask: use it (switch to repair mode), or create anyway.

## 2. Pick the template

`list_templates` with `team: "SmartContract"`, `type: "issue"`. Use an EXSC-specific template when one matches (new bridge, new DEX, new EVM chain, chain deploys); otherwise **Bug Ticket** for defects, **Task Ticket** for everything else. Pass it as `template` and keep its section headings when writing the body.

## 3. Draft the title and body

The reader has no access to this conversation; often it is a coding agent that cannot ask follow-up questions. EXSC-1312 is the reference for the shape:

- Title names the outcome, readable from the board without opening the ticket.
- Context with links to the source (Slack thread, PR, tx hash + network, related ticket).
- **Done when**: pass/fail outcomes describing the target state, not implementation steps. Add **Out of scope** when a reader could reasonably assume more.
- **Agent notes** last and collapsed: file paths, functions, patterns to copy, overlapping tickets, and what step 4 considered and rejected. Linear's collapsible syntax:

  ```text
  +++ Agent notes

  - `script/deploy/...`: ...

  +++
  ```

One ticket = one PR. If the Done-when list spans unrelated areas, propose splitting into sub-issues (`parentId`) before writing.

## 4. Challenge the draft

A ticket can be well formed and still wrong: the problem may not reproduce, a named helper may not exist, or one shared change may replace the N copies the ticket asks for. Catch that before the ticket is saved.

**a. Scout** (facts only, always):

- Every path, function, script and flag the draft names exists. Never cite one you didn't find.
- Every claim about the problem holds against code, chain state or logs. Mark a claim you couldn't verify as unverified in the body.
- Look for an existing skill (`.agents/commands/`), script or helper that already does part of the work, and for open EXSC tickets that overlap.

Called from `/create-pr`, the work is already done: run only the scout, against the diff, and skip **b**.

**b. Challenger** (judgment, built on the scout's facts):

- **Simpler**: one shared change instead of N copies, an existing tool instead of a new one, less scope.
- **Safe**: Safe and timelock are never bypassed; selector and storage layout, privileged paths and external-call patterns stay as `002-architecture` requires.
- **Right size**: one PR. A removal also covers every caller, import, config key and doc that references it.
- Each finding cites evidence (file and line, or a search result), states its cost in files, copies or steps, and proposes the alternative. Return specific findings, or say why the draft has none; "looks good" alone is not a review.

Run **b** yourself for estimate 1–2. When the draft is likely 3 or more, or touches a contract, governance or a `money-path` ticket, spawn one `general-purpose` subagent that gets only the draft, the scout's facts and these rules, so your own reasoning doesn't steer it.

**c. Resolve**: fix the draft or rebut each finding, once. Record the alternatives weighed under "Considered and rejected" in Agent notes, so the implementer doesn't reopen them. Anything still disputed goes to the preview with your recommendation. If a contract, governance or `money-path` concern fired, say in the body that the ticket needs core review.

## 5. Propose the estimate

Scale used by EXSC: **1** (single small change), **2** (a few files or one script/skill), **3** (multi-file feature or cross-cutting change), **5** (several components or repos; consider splitting). Base it on the Done-when list after step 4. Unattended runs use the proposal as is.

## 6. Resolve the cycle and the InCursu label

Base both on **now** (when the ticket joins a cycle), not on the ticket's `createdAt`. Get now from `date -u +%Y-%m-%dT%H:%M:%SZ`; the date in context has no time of day, and the boundaries below are hour-precise. Then `list_cycles` with `teamId: "EXSC"`, `type: "current"`:

| Now is…                                              | `cycle`               | `InCursu` |
| ---------------------------------------------------- | --------------------- | --------- |
| Within the first 24h after `startsAt` (planning day) | current               | no        |
| After that, and more than 24h before `endsAt`        | current               | **yes**   |
| Within the last 24h before `endsAt`                  | next (`type: "next"`) | no        |
| No current cycle                                     | next                  | no        |

If the next cycle is needed and doesn't exist yet, ask the user; never leave the field empty silently. In repair mode, a ticket already in the current or next cycle keeps its cycle; only the label rule is applied to it.

## 7. Preview, then save

Show the title, body, step 4 findings (fixed, rebutted or open, each with your recommendation), estimate, cycle, `InCursu` with its reason, labels and the duplicates reviewed, then wait for approval (unattended runs skip the wait).

Create with one `save_issue` call: `team`, `template`, `title`, `description`, `assignee: "me"`, `estimate`, `cycle`, and `labels` (include `InCursu` when step 6 says so). In repair mode use `id` plus only the missing fields, and `addLabels: ["InCursu"]` — never `labels`, which replaces the full set.

A `save_issue` error (Linear returns 502s) can still have saved. Before retrying a create, `list_issues` with the exact title and `createdAt: "-PT10M"`; if it exists, continue with step 8 on that ID instead of creating a duplicate.

## 8. Verify

`get_issue` with `fields: ["assignee", "estimate", "cycleId", "labels", "url"]`. If any required field did not land, retry that field once with `save_issue` + `id`; if it still fails, report which field and the error. Report the ID, URL and the fields as saved.

When a reviewer or implementer later finds a problem step 4 should have caught, add that check to step 4.
