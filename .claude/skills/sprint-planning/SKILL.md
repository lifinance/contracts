---
name: sprint-planning
description: Sprint capacity planning for LI.FI squads. Pulls next sprint dates from Linear, checks team availability from HiBob, calculates historical velocity per role group (QA / Backend Dev / Smart Contract Dev), and outputs adjusted story point targets. Use when someone says "plan next sprint", "sprint planning", "what's our sprint capacity", "how many story points for next sprint", "sprint capacity for [squad]".
---

# Sprint Planning

Run a full sprint capacity analysis for a squad: sprint window from Linear, team roster + availability from HiBob, historical velocity from past cycles, and adjusted story point targets per role group.

## When to run

- "Plan next sprint for API Expansion"
- "What's our sprint capacity?"
- "How many story points can we take on?"
- "Sprint planning for [squad name]"

## Inputs to collect

Before starting, confirm with the user (use defaults if they agree):

| Input | Default |
|-------|---------|
| Squad name | API Expansion |
| Historical sprints to average | 3 |

If the user's message already includes these (e.g., "plan next sprint for Protocol using 5 sprints"), use those values directly without asking.

---

## Procedure

### Step 0 — Load squad config

Before doing anything else, read the config file for the squad:

```
skills/sprint-planning/config/<squad-slug>.md
```

Where `<squad-slug>` is the squad name lowercased with spaces replaced by hyphens (e.g., "API Expansion" → `api-expansion.md`).

If the file exists, extract and store:
- **Capacity overrides** — per-person coding capacity % (overrides HiBob and 100% default in Step 5)
- **Squad member mapping notes** — corrections to HiBob/Linear data
- **Velocity notes** — guidance for when estimates are missing

If no config file exists for this squad, proceed with defaults (no overrides).

Tell the user: "Config loaded for [squad]." and list any active overrides:
> Config loaded. Active overrides: Marcin (0% — on another team), Michał (0% — on another team), Daniel (20% coding capacity — Engineering Lead).

### Step 1 — Find the Linear team

Call `list_teams()` from the Linear MCP.

Find the team whose name contains the squad name (case-insensitive). For "API Expansion", match teams like "API Expansion", "API Expansion EVM", etc. — if there are multiple, pick the most specific match or ask the user.

Store: `teamId`, `teamName`

### Step 2 — Find the next sprint cycle

Call `list_cycles(teamId)`.

Find the next **upcoming** cycle (state = "future" or closest future `startDate`). If no upcoming cycle exists, tell the user: "No upcoming cycle found in Linear for [team]. Sprint planning cannot proceed until a cycle is created."

Store: `cycleId`, `cycleName`, `startDate`, `endDate`

Present to user:
> Next sprint: **[cycleName]** — [startDate] to [endDate]

### Step 3 — Get squad members from HiBob

Invoke `/hibob:squad-members` with the squad name.

Group the returned members by `department` into role buckets:
- **QA** — department contains "QA" or "Quality" (case-insensitive)
- **Smart Contract** — department contains "Smart Contract" or "Solidity" (case-insensitive)
- **Backend Dev** — all other squad members

Store member list with `{name, email, department, roleGroup}`.

If fewer than 2 members are returned, warn: "Only [N] member(s) found in HiBob for '[squad]'. Check the department name matches HiBob exactly."

### Step 4 — Close the previous sprint, then read velocity from history

Velocity is tracked as **SP per effective FTE-day** in `history/<squad-slug>.md`.
That file is the single source of truth — the skill never recomputes FTE-days from APIs for past sprints,
because HiBob leave data is incomplete (missing public holidays, ad-hoc absences, etc.).

#### 4a — Close the previous sprint (if not yet recorded)

Identify the most recently *completed* cycle (the one that ended just before the upcoming sprint).
Check whether it already has an entry in `history/<squad-slug>.md`.

**If already recorded:** skip to 4b.

**If NOT recorded:** draft an entry now.

1. Fetch completed SP from Linear: `list_issues(teamId, cycleId)` → sum estimates for Done issues per group
2. Draft FTE-days from config: `Σ (working_days(cycle) × capacity_pct(person, cycle))` per group
3. Present the draft to the user in one compact block:

```
Closing Expansion Cycle 5 (Apr 14–28) before planning Cycle 7.

  Group           SP (from Linear)   FTE-days (from config)   Rate
  Backend Dev          20                    40                0.50
  Smart Contract        3                    30                0.10
  QA                    0                    10                 —

Were there any public holidays, unplanned absences, or other
availability changes during Apr 14–28 I should adjust?
(e.g. "Good Friday Apr 18 hit everyone" → -4 backend days, -3 SC days, -1 QA day)
Or: "Looks right, save it."
```

4. Apply any adjustments the user gives, recompute rates, then **save the entry** to `history/<squad-slug>.md` (prepend at the top, most-recent-first). Propose a PR message for the shared repo.

5. If the user says "skip for now" or "I'll do it later", proceed without saving — but note that velocity data for that sprint is missing from history.

#### 4b — Read velocity from history

Load `history/<squad-slug>.md`. Take the last N entries (most recent first).

For each entry:
- Read `Completed SP` and `FTE-Days` directly from the file — do not recompute
- `velocity_rate[group][s] = Completed SP / FTE-Days`
- Skip entries where Rate = `—` (estimates missing — not a zero, just absent data)

Average across qualifying entries:
- `velocity_rate[group] = mean(velocity_rate[group][s])`
- Flag if < 2 qualifying entries: "⚠️ Limited history"
- Flag if 0 qualifying entries: ask user for a manual rate

See [references/capacity-calculation.md](references/capacity-calculation.md) for the full formula.

### Step 5 — Determine availability for the upcoming sprint

**5a — Resolve effective FTE-days per member** using the config dated overrides for the upcoming sprint window:
- `effective_days(person) = sprint_working_days × capacity_pct(person, startDate, endDate)`
- Members resolving to 0% contribute 0 days and are shown as `--` in the table

**5b — Try HiBob for time-off:** Invoke `/hibob:availability` with `from=startDate`, `to=endDate`.
- If HiBob returns leave data, subtract those absent days from each affected member's effective days
- If HiBob returns empty (API permissions not yet configured), skip

**5c — Ask for manual adjustments:**
> "I'm using [config overrides + HiBob data / config overrides + 100% default] for capacity. Does anyone have planned leave, public holidays, or further changes during this sprint?"

Accept natural language: "Daniel is out 3 days", "Public holiday May 1 affects everyone", "Everyone is fully available". Subtract from the relevant member's effective days.

**5d — Group capacity %:**
```
current_effective_FTE_days[group] = Σ effective_days(person) for all members in group
capacity_pct[group] = current_effective_FTE_days[group] / (member_count[group] × sprint_working_days) × 100
```

### Step 6 — Calculate available story points

For each role group:
```
available_SP[group] = round(velocity_rate[group] × current_effective_FTE_days[group])
```

This automatically accounts for team size changes: if a new person joins, their FTE-days add to the multiplier; if someone leaves, their days drop out — without distorting the historical rate.

### Step 7 — Present results

Output in four blocks in this order:

**Block 1 — Member list**
One line per member: name, email, role group, and any active config override.

**Block 2 — Availability table (members as rows, working days as columns)**

Members are rows, grouped by role. One column per working day (Mon–Fri), plus a right-hand "Days" and "Eff." column. A sum row closes each group.

Alignment rules (follow exactly to keep columns flush):
- Name column: left-padded to 18 chars (including 2-space indent for members)
- Each day cell: exactly 4 chars wide — use `" ok "` for available, `" -- "` for 0%-capacity, `" hb "` for HiBob leave
- Days / Eff. columns: right-aligned in a 4-char field
- Group header row spans full width with no day cells filled

```
## Availability: [cycleName] · [startDate] → [endDate] · [N] working days
                    13/5 14/5 15/5 18/5 19/5 20/5 21/5 22/5 25/5 26/5   Eff.
──────────────────────────────────────────────────────────────────────────────
BACKEND DEV
  Daniela           ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Joao              ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Nathan            ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Victor            ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Marcin            --   --   --   --   --   --   --   --   --   --        0  (other team)
  GROUP TOTAL                                                              40
──────────────────────────────────────────────────────────────────────────────
SMART CONTRACT
  Goran             ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Michal            ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Daniel            ok   ok   ok   ok   ok   ok   ok   ok   ok   ok        2  (20% coding)
  GROUP TOTAL                                                              22
──────────────────────────────────────────────────────────────────────────────
QA
  Yordan            ok   ok   ok   ok   ok   ok   ok   ok   ok   ok       10
  Mayode            --   --   --   --   --   --   --   --   --   --        0  (other team)
  GROUP TOTAL                                                              10
──────────────────────────────────────────────────────────────────────────────
TOTAL                                                                      72
──────────────────────────────────────────────────────────────────────────────
```

Cell legend: `ok` = available · `--` = not on team / 0% config · `hb` = HiBob leave

No capacity % column — it is always implicit. The Eff. column is the only number that matters.
If there are temporary deviations (holidays, leave), note them below the table as a delta:
```
  ⚠️  May 1 Labour Day — if observed: −4 Backend, −2 Smart Contract, −1 QA effective days
  ⚠️  HiBob time-off data unavailable (API permissions pending)
```

After deviations, print one line per config override so users know what's permanent:
```
Config overrides (edit config/api-expansion.md to change permanently):
  Marcin — not on team (other squad since Feb 15)
  Daniel — 20% coding capacity (Engineering Lead)
  Mayode — not on team (other squad since Apr 10)
```

**Block 3 — Historical velocity table**

```
## Historical Velocity (last [N] sprints)

Role Group       Sprint [name]   Sprint [name]   Sprint [name]   Average
────────────────────────────────────────────────────────────────────────
Backend Dev           38 pts          44 pts          40 pts      41 pts
Smart Contract         3 pts           1 pts           1 pts       2 pts
QA                     0 pts            —               —         ⚠️ n/a
```

Flag per group if: < 2 data points, all estimates missing, or if config velocity notes apply.

**Block 4 — Summary and available SP**

```
## Sprint Capacity: [cycleName]

Role Group       Eff. FTE-days   Avg Rate (SP/day)   Available SP
────────────────────────────────────────────────────────────────────
Backend Dev           40              0.55               22 pts
Smart Contract        22              0.13                3 pts
QA                    10             ⚠️ n/a               ? pts
────────────────────────────────────────────────────────────────────
TOTAL                 72                                ~25 pts

Velocity rate based on last [N] sprints: [cycle names]
```

Then offer two prompts on separate lines:
1. "Want me to recalculate with different numbers, or does this look right?"
2. "Any of these capacity settings need a permanent update? I can edit `config/api-expansion.md` for you — changes will apply to all future sprint runs."

---

## Guardrails

- **Read-only** — never create or modify Linear issues or HiBob records from this skill
- If Linear has no story point estimates on past issues, do **not** report 0 as the available SP. Instead warn: "⚠️ [Group]: No estimates found on completed issues — velocity can't be calculated from history. What's a realistic sprint target based on your experience?" Then use whatever number the user provides.
- If a role group has no members (e.g., no Smart Contract devs in the squad), skip that row
- Do not extrapolate beyond the data — if only 1 historical cycle has data, say so clearly
- Members with 0% coding capacity (from config) contribute 0 effective FTE-days and are shown as `--` in the availability table with a short reason. Never show a capacity % — just the Eff. FTE-days number.
- Never show a "capacity %" column in any table. The only metric is effective FTE-days.
