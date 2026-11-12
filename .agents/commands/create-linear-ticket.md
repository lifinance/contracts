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

A well-formed ticket can still be wrong: the problem may not reproduce, a named helper may not exist, or one shared change may replace the N copies it asks for. The implementer treats the ticket as settled, so this is the cheapest point to catch it. Match the effort to the ticket: a few searches for a one-file change, more for a contract or governance change.

- **Facts**: the paths, functions and flags the draft names exist; its claims about the problem hold against code, chain state or logs (mark the ones you couldn't check as unverified); no existing skill, script or open EXSC ticket already covers the work.
- **Simpler**: an existing tool, or one shared change instead of N copies. Stay within the ticket's outcome; a redesign beyond it is a separate ticket.
- **Safe**: no bypass of Safe or timelock, no change to selector or storage layout, no new privileged path or external-call pattern (`002-architecture`).
- **Size**: one PR; a removal also covers every caller, import, config key and doc that references it.

Back each finding with evidence and its cost (files, copies, steps), and propose the alternative. No findings is a valid result.

When the ticket touches a contract, governance or `money-path`, or is likely estimate 3 or more, have a fresh subagent do the judgment part from the draft and your facts alone: having written the draft, you are the reader least likely to see its gaps.

Called from `/create-pr`, the design is already built: check only the facts, against the diff.

Then fix the draft or rebut each finding. Record the alternatives weighed under "Considered and rejected" in Agent notes, so the implementer doesn't reopen them. Unresolved findings go to the preview with your recommendation; a contract, governance or `money-path` concern also gets "needs core review" in the body.

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
