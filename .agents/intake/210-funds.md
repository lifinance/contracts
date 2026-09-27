---
name: Funds scripts
description: A change to a script that moves money states its impact and carries the high blast radius label
areas: [funds]
requires:
  - section: Funds impact
    check: nonempty
    hint: Which wallets and chains the change can move funds on, and what stops a wrong transfer
  - label: blast-radius:high
    check: present
    hint: These scripts move real funds
---

The factory base rule refuses `blast-radius:high`, so a funds ticket bounces on both rules for now,
and the bounce says so. When the factory admits high blast radius, the base rule changes and this
one does not.
