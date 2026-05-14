# Sprint Planning Config — Example Squad

This file is read automatically by the `/sprint-planning` skill at the start of every run.
Edit it to update capacity overrides — changes apply to the next sprint planning run immediately.

The filename must match the squad slug: lowercase, spaces replaced with hyphens
(e.g. squad "API Expansion" → `config/api-expansion.md`).

---

## Capacity Overrides

Entries here define each person's coding capacity for a date range.
The skill uses these to reconstruct team composition for **both past and future sprints**,
enabling normalized velocity (SP per FTE-day) that stays valid as the team grows or shrinks.

Rules:
- `Until` = `—` means the override is still active today
- A person with no entry is assumed 100% for all time
- Multiple rows for the same person are allowed (e.g. 0% → then back to 100%)
- Dates are YYYY-MM-DD

| Person | Email | Capacity | From | Until | Reason |
|--------|-------|:--------:|------|-------|--------|
| Example Lead | example.lead@li.finance | 20% | 2026-01-01 | — | Engineering Lead — 80% is management, reviews, coordination |

**When someone returns:** set their `Until` date and add a new 100% row from the return date.

**When someone joins:** add a 100% row from their start date (so past sprints without them aren't inflated).

---

## Squad Member Mapping Notes

Corrections to HiBob or Linear data the skill should know about. Example:

- **someAssignee** — appears in Linear issues but NOT in HiBob squad. Do not map to any role group.
- **QA:ExampleSquad** Linear team was created recently. Insufficient historical data — flag velocity as insufficient rather than using 0.

---

## Velocity Notes

- Story point estimates may be **sparsely set** across Linear teams.
- When calculated velocity rate = 0 due to missing estimates, do NOT report 0 as the sprint capacity. Instead, warn the user and ask for a manual SP-per-FTE-day rate or a total target.

---

## How to Update This File

For **permanent changes**: edit this file (PR into the shared skills repo).
For **one-off sprint adjustments** (e.g. "Person X is out 2 days next sprint", "public holiday May 1"):
provide them interactively when the skill asks — don't add them here.
