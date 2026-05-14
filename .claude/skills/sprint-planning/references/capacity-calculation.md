# Capacity Calculation Reference

## Core Concept: SP per FTE-Day

Raw sprint velocity (total story points) is not comparable across sprints when team size changes.
Instead, track **SP per effective FTE-day** — a normalized rate that remains valid as people
join, leave, or change capacity.

```
velocity_rate[group] = completed_SP[group][sprint] / effective_FTE_days[group][sprint]
available_SP[group]  = avg(velocity_rate[group]) × current_effective_FTE_days[group]
```

---

## Working Days

Working days = Mon–Fri only. No public holiday awareness (conservative: treat all weekdays as working).

To count working days between two dates (inclusive):
1. Iterate each calendar day from `from` to `to`
2. Count days where `dayOfWeek` is not Saturday (6) or Sunday (0)

---

## Step 1 — Resolve Capacity Per Person Per Sprint

For each person in the squad and each historical/upcoming sprint, look up their coding capacity
using the config file's dated override table:

```
capacity_pct(person, sprint_start, sprint_end):
  Find all config rows for this person where:
    row.From <= sprint_end  AND  (row.Until == '—' OR row.Until >= sprint_start)
  If multiple rows overlap, use the one with the latest From date.
  If no row matches, return 100%.
```

This means:
- Marcin at 0% from 2026-02-15 → any sprint starting after Feb 15 treats him as 0%
- A new hire joining 2026-06-01 → any sprint before June 1 treats them as absent (not in the team yet)

---

## Step 2 — Effective FTE-Days Per Group Per Sprint

```
sprint_working_days            = count Mon–Fri days in sprint window (inclusive)

effective_FTE_days[group][s]   = Σ (sprint_working_days × capacity_pct(person, s))
                                   for each person in group
```

Also compute the **baseline FTE-days** (what 100% capacity for all current members would be):
```
baseline_FTE_days[group]       = member_count[group] × sprint_working_days
```

The capacity % shown in the summary table is:
```
capacity_pct[group] = effective_FTE_days[group] / baseline_FTE_days[group] × 100
```

---

## Step 3 — Velocity Rate Per Historical Sprint

```
completed_SP[group][s]  = Σ issue.estimate for completed issues assigned to group members in sprint s
                          (exclude issues with no estimate from the sum, but note them)

velocity_rate[group][s] = completed_SP[group][s] / effective_FTE_days[group][s]
                          (skip sprint s for this group if effective_FTE_days == 0)
```

Exclude a sprint from the average if:
- `effective_FTE_days[group][s] == 0` (no one in this group was active that sprint)
- `completed_SP[group][s] == 0` AND no member in the group was assigned any issues that sprint
  (i.e. they simply weren't tracked, not that they completed nothing)

---

## Step 4 — Average Velocity Rate

```
velocity_rate[group] = mean(velocity_rate[group][s])
                       across qualifying sprints (see exclusion rules above)
```

If fewer than 2 qualifying sprints exist, flag as "⚠️ Limited history — estimate may be inaccurate".
If all qualifying sprints have 0 completed SP (estimates missing), flag as "⚠️ No estimates — cannot calculate rate" and ask the user for a manual rate or target.

---

## Step 5 — Available Story Points

```
current_effective_FTE_days[group] = Σ (sprint_working_days × capacity_pct(person, upcoming_sprint))
                                      for each person in group

available_SP[group] = round(velocity_rate[group] × current_effective_FTE_days[group])
```

---

## Step 6 — Total Row

```
total_effective_FTE_days = Σ current_effective_FTE_days[group]
total_available_SP       = Σ available_SP[group]
total_capacity_pct       = total_effective_FTE_days / (total_member_count × sprint_working_days) × 100
```

---

## Example

Two backend sprints, Marcin moved to another team from sprint 2 onward.

**Sprint 1** (10 working days, 5 members all at 100%):
- effective FTE-days = 5 × 10 = 50
- completed SP = 30
- velocity_rate = 30 / 50 = **0.60 SP/FTE-day**

**Sprint 2** (10 working days, Marcin at 0%):
- effective FTE-days = 4 × 10 = 40
- completed SP = 24
- velocity_rate = 24 / 40 = **0.60 SP/FTE-day**

**Next sprint** (10 working days, Marcin still at 0%, new hire joins):
- effective FTE-days = 5 × 10 = 50  (4 original + 1 new)
- avg velocity_rate = (0.60 + 0.60) / 2 = 0.60
- available_SP = round(0.60 × 50) = **30 pts**

Without normalization the raw average would be (30 + 24) / 2 = 27 pts, and the new hire would be invisible to the calculation. With normalization the team gets full credit for their new capacity.
