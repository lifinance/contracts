---
name: Smart contracts
description: A smart-contract change is declared as high blast radius and states its impact before work starts
areas: [contracts]
requires:
  - label: blast-radius:high
    check: present
    hint: The factory changes src/ only on a ticket declared high blast radius
  - section: Contracts impact
    check: nonempty
    hint: What changes in which contracts, the invariants it must keep, and whether storage layout or selectors move
---

The factory's floor protects `src/`. A ticket labelled `blast-radius:high` lifts that for its own job,
once the factory's `high_blast_radius` switch is on; the job then runs `/gate-review` every triage
round, gets a second-vendor review, must pass `forge build` and `forge test`, and asks for a second
human reviewer. While the switch is off, the factory's base rule refuses the label and every
contracts ticket bounces.
