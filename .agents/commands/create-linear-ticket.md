---
name: create-linear-ticket
description: 'Creates an EXSC Linear ticket, or repairs an existing one, so it always has an assignee, an estimate and a cycle, plus the InCursu label when it joins a running cycle. Writes a scannable title and a self-contained body with binary Done-when criteria and collapsible Agent notes, then has a fresh subagent cold-read it against the code (guesses, wrong facts, edge cases, existing helpers, simpler or safer options) so it is implementation-ready before saving. Use for "create a ticket", "open a Linear issue for X", "fix the ticket metadata on EXSC-123", or when another skill needs a ticket (create-pr).'
---

# Create Linear Ticket

## Inputs

- **What the ticket is for**: conversation context, a pasted draft, a Slack thread, or a diff (when called from `/create-pr`).
- **Existing ticket ID** (optional): repair mode. Skip steps 1–4; apply steps 5–8 to that ticket and never rewrite its title or body. Run step 4 only when the user asks for it.
- **Factory job**: if the ticket is meant for the AI Factory and `/factory-ticket` is installed (a user-level skill, not in this repo), hand off to it — it owns that template and the intake gate. Then run repair mode on the result; it fills only missing fields and keeps the assignee, delegate and cycle intake set. Without that skill, write a normal ticket and say so.
- **Scope shape**: when the request says migrate, replace, move, consolidate or refactor, ask once whether it is a swap (old data abandoned), a migration (data preserved), a new feature, or an internal refactor. Hold the draft and step 4 to that shape; it keeps a swap from growing phases, flags or dual paths.
- **Unattended** (nobody to answer): take your recommendation for each question and name it in the report; scope shape goes in Agent notes. Two questions stop the run instead, reported without saving: an open duplicate in step 1, and a missing next cycle in step 6.
- **Called from `/create-pr`**: the work is already built and `/create-pr` owns the questions. Its route 3 replaces step 1. Run steps 2–6 before its pre-flight: draft the step 3 body from the diff, and in step 4 skip the subagent and check only the facts against the diff. The pre-flight is the step 7 preview. After approval run only the save and step 8, with no new questions; if something would need one (a crossed cycle boundary, a missing next cycle), stop and show the change in a new pre-flight. Repairs from `/create-pr` run steps 5–8 the same way.

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

`list_templates` with `team: "SmartContract"`, `type: "issue"`. Use an EXSC-specific template when one matches (new bridge, new DEX, new EVM chain, chain deploys); otherwise **Bug Ticket** for defects, **Task Ticket** for everything else. `get_template` returns its body; pass it as `template` and write the body under its section headings, because a non-empty `description` replaces the template body rather than merging with it.

## 3. Draft the title and body

The reader has no access to this conversation; often it is a coding agent that cannot ask follow-up questions. EXSC-1312 is the reference for the shape:

- Title names the outcome, readable from the board without opening the ticket.
- Context with links to the source (Slack thread, PR, tx hash + network, related ticket).
- **Done when**: pass/fail outcomes describing the target state, not implementation steps. Each is provable by a command, test or observable result; state the rule and give today's values as examples, so a test built from it doesn't break when config or data changes. Add **Out of scope** when a reader could reasonably assume more.
- **Agent notes** last and collapsed: file paths, functions, patterns to copy, overlapping tickets, and what step 4 considered and rejected. Linear's collapsible syntax:

  ```text
  +++ Agent notes

  - `script/deploy/...`: ...

  +++
  ```

One ticket = one PR. If the Done-when list spans unrelated areas, propose splitting into sub-issues (`parentId`) before writing.

## 4. Make it implementation-ready

The ticket is ready when someone with only the ticket and the repo can implement it without guessing, and its Done-when items prove the result. The implementer treats the ticket as settled, so gaps left here become follow-up commits and review rounds. Backtested on finished EXSC tickets, a cold read against the code found the costliest ones before any code was written: a parser that already existed, a CI manifest step nobody mentioned, a fee margin that also set the fee limit.

Give one fresh `general-purpose` subagent the draft and the repo, not this conversation: having written the draft, you are the reader least likely to see its gaps. It works read-only and is briefed to:

- **Plan it cold**: the files it would change and how, and how it would prove each Done-when item. Report every point where it had to guess, every instruction that would give wrong or failing code if followed literally, and every Done-when item it can't prove as written.
- **Check the facts**: paths, functions, flags and numbers exist and behave as stated; the problem's claims hold against code, chain state or logs; no skill, script or helper already does part of the work. (Overlapping tickets are step 1's job; subagents may not reach Linear.)
- **Probe the edges** of each behaviour the ticket changes: list the cases whose outcome flips (fail to pass, alert to silent, revert to success) and check each one is intended, including nothing to do, every input failing, missing or uninitialized state, and state the code already keeps from earlier runs.
- **Apply the repo's requirements**: the `.agents/rules/` whose paths match the files to change, and what CI checks there (manifests, redaction, invariants).
- **Look for simpler**: an existing tool, or one shared change instead of N copies, within the ticket's outcome.
- **Check safety**: no bypass of Safe or timelock, selector and storage changes stay upgrade-compatible, and no new privileged path or external-call pattern (`002-architecture`).
- **Check size**: one PR in one repo; a removal covers every caller, import, config key and doc.
- Back each finding with evidence (file and line, or a command result) and give the line that would close it in the ticket.

Then close the gaps. Check a finding before changing the ticket on it. Write each answer the code gives into Done when, Out of scope or Agent notes; ask the user about each one that is a decision (a value, a trade-off, the scope) in the preview, with your recommendation. Record the alternatives weighed under "Considered and rejected" in Agent notes, so the implementer doesn't reopen them. A contract, governance or `money-path` concern also gets "needs core review" in the body.

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

If the next cycle is needed and doesn't exist yet, ask the user; never leave the field empty silently.

In repair mode the rule applies only when this run puts the ticket into a cycle, because `InCursu` describes when it joined:

- Already in the current or next cycle: keep the cycle and leave `InCursu` as it is; the join time isn't known, so the label can't be judged now.
- No cycle, or a past one: move it to the cycle from the table, add `InCursu` if the table says so, and remove a stale `InCursu` if it doesn't.

If approval comes after the time crossed a boundary in the table, resolve again and show the change.

## 7. Preview, then save

Show the title, body, step 4 findings (fixed, rebutted or open, each with your recommendation), estimate, cycle, `InCursu` with its reason, labels and the duplicates reviewed, then wait for approval (unattended runs skip the wait).

Create with one `save_issue` call: `team`, `template`, `title`, `description`, `assignee: "me"`, `estimate`, `cycle`, and `labels` (include `InCursu` when step 6 says so). In repair mode use `id` plus the missing fields, the assignee when the user approved a reassignment, and any cycle step 6 replaced, with `addLabels` / `removeLabels` for `InCursu` — never `labels`, which replaces the full set.

A `save_issue` error (Linear returns 502s) can still have saved. Before retrying a create, `list_issues` with the exact title, `createdAt: "-PT10M"` and `assignee: "me"`, leaving out the duplicates shown in step 1. If exactly one remains, continue with step 8 on that ID; if several remain, ask the user which one is theirs instead of creating another.

## 8. Verify

`get_issue` with `fields: ["assignee", "estimate", "cycleId", "labels", "url"]`. If any required field did not land, retry that field once with `save_issue` + `id`; if it still fails, report which field and the error. Report the ID, URL and the fields as saved.

When a reviewer or implementer later finds a problem step 4 should have caught, add that check to step 4.
