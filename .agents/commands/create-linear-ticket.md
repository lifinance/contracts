---
name: create-linear-ticket
description: 'Creates an EXSC Linear ticket, or repairs an existing one, so it always has an assignee, an estimate and a cycle, plus the InCursu label when it joins a running cycle. Writes a scannable title, a self-contained body with binary Done-when criteria and collapsible Agent notes. Use for "create a ticket", "open a Linear issue for X", "fix the ticket metadata on EXSC-123", or when another skill needs a ticket (create-pr).'
---

# Create Linear Ticket

## Inputs

- **What the ticket is for**: conversation context, a pasted draft, a Slack thread, or a diff (when called from `/create-pr`).
- **Existing ticket ID** (optional): repair mode. Skip steps 1–3; apply steps 4–7 to that ticket and never rewrite its title or body.
- **Factory job**: if the ticket is meant for the AI Factory, hand off to `/factory-ticket` instead — it owns that template and the intake gate. Then run repair mode on the result.

## Required fields

Sprint reporting counts only tickets that are assigned, estimated and in a cycle, so a ticket missing any of them is invisible to planning. `InCursu` marks scope added to a sprint after it started, which separates planned work from unplanned work in the retro. Apply these by that intent when a case below doesn't fit.

| Field           | Value                                                     |
| --------------- | --------------------------------------------------------- |
| `team`          | `SmartContract` (EXSC)                                    |
| `assignee`      | `"me"`; ask before reassigning a ticket someone else owns |
| `estimate`      | proposed in step 4, confirmed by the user                 |
| `cycle`         | resolved in step 5                                        |
| `InCursu` label | added when step 5 says so                                 |

## 1. Check for duplicates

`list_issues` with `team: "SmartContract"` and `query` set to 2–3 distinctive title keywords. No `assignee` filter. If an open ticket covers the same outcome, show the top 3 as `ID — title — status` and ask: use it (switch to repair mode), or create anyway.

## 2. Pick the template

`list_templates` with `team: "SmartContract"`, `type: "issue"`. Use an EXSC-specific template when one matches (new bridge, new DEX, new EVM chain, chain deploys); otherwise **Bug Ticket** for defects, **Task Ticket** for everything else. Pass it as `template` and keep its section headings when writing the body.

## 3. Write the title and body

The reader has no access to this conversation; often it is a coding agent that cannot ask follow-up questions. EXSC-1312 is the reference for the shape:

- Title names the outcome, readable from the board without opening the ticket.
- Context with links to the source (Slack thread, PR, tx hash + network, related ticket).
- **Done when**: pass/fail outcomes describing the target state, not implementation steps. Add **Out of scope** when a reader could reasonably assume more.
- **Agent notes** last and collapsed: file paths, functions, patterns to copy, overlapping tickets. Linear's collapsible syntax:

  ```text
  +++ Agent notes

  - `script/deploy/...`: ...

  +++
  ```

One ticket = one PR. If the Done-when list spans unrelated areas, propose splitting into sub-issues (`parentId`) before writing.

## 4. Propose the estimate

Scale used by EXSC: **1** (single small change), **2** (a few files or one script/skill), **3** (multi-file feature or cross-cutting change), **5** (several components or repos; consider splitting). Base it on the Done-when list. Unattended runs use the proposal as is.

## 5. Resolve the cycle and the InCursu label

Base both on **now** (when the ticket joins a cycle), not on the ticket's `createdAt`. Get now from `date -u +%Y-%m-%dT%H:%M:%SZ`; the date in context has no time of day, and the boundaries below are hour-precise. Then `list_cycles` with `teamId: "EXSC"`, `type: "current"`:

| Now is…                                              | `cycle`               | `InCursu` |
| ---------------------------------------------------- | --------------------- | --------- |
| Within the first 24h after `startsAt` (planning day) | current               | no        |
| After that, and more than 24h before `endsAt`        | current               | **yes**   |
| Within the last 24h before `endsAt`                  | next (`type: "next"`) | no        |
| No current cycle                                     | next                  | no        |

If the next cycle is needed and doesn't exist yet, ask the user; never leave the field empty silently. In repair mode, a ticket already in the current or next cycle keeps its cycle; only the label rule is applied to it.

## 6. Preview, then save

Show the title, body, estimate, cycle, `InCursu` with its reason, labels and the duplicates reviewed, then wait for approval (unattended runs skip the wait).

Create with one `save_issue` call: `team`, `template`, `title`, `description`, `assignee: "me"`, `estimate`, `cycle`, and `labels` (include `InCursu` when step 5 says so). In repair mode use `id` plus only the missing fields, and `addLabels: ["InCursu"]` — never `labels`, which replaces the full set.

A `save_issue` error (Linear returns 502s) can still have saved. Before retrying a create, `list_issues` with the exact title and `createdAt: "-PT10M"`; if it exists, continue with step 7 on that ID instead of creating a duplicate.

## 7. Verify

`get_issue` with `fields: ["assignee", "estimate", "cycleId", "labels", "url"]`. If any required field did not land, retry that field once with `save_issue` + `id`; if it still fails, report which field and the error. Report the ID, URL and the fields as saved.
