<!--
  External partner report - drafted against:
  docs/superpowers/specs/2026-06-16-emergency-pause-external-report-design.md
  This markdown is the finalized text. LI.FI branding + PDF production is the downstream step.
-->

# Production Emergency-Response Exercise

## Confirming LI.FI's Ability to Protect User Funds

*On 28 May 2026, LI.FI ran a full end-to-end test of its automated emergency-pause capability in production - and confirmed it works as designed.*

**Prepared by the LI.FI Smart Contract Security Team**

---

## Executive summary

LI.FI operates an automated safeguard that can **pause its production smart contracts within
moments of a threat being detected**, freezing activity to protect user funds. The contracts
are monitored around the clock by Hexagate, a Chainalysis company, which can trigger this
response automatically.

On **28 May 2026** we tested that entire capability end-to-end, in production, for the first
time. The exercise was meticulously planned around a detailed written runbook, executed under
a strict four-eyes principle, and deliberately staged so that it was reversible at every step.

**The result: the capability works.** Threat detection, authorization, the built-in safety
stops, multi-channel team alerting, and rapid recovery all performed exactly as designed. As
with any rigorous exercise, we identified a small set of operational refinements - and have
since implemented all of them, further strengthening an already-working system.

---

## Why this capability matters

Smart contracts hold and move real user funds. If one ever came under attack, the single most
important defensive action is the ability to **pause it instantly** - to freeze activity
before an attacker can cause harm, buying time to respond.

A pause capability is only meaningful if it is **fast, reliable, and continuously ready**.
That means it cannot depend on someone happening to be awake and at a keyboard: it must be
backed by 24/7 monitoring that can detect a threat and trigger the response automatically,
and it must be tested under realistic conditions so there are no surprises when it matters.
This exercise was designed to prove exactly that.

---

## How we ensured a safe, controlled exercise

Testing an emergency control in production demands discipline. We applied several layers of
control:

- **A four-eyes principle, executed as a team.** The entire smart contract team, together
  with a member of the security team, ran the exercise in a single shared session - working
  through every step of the runbook together rather than any one person acting alone. Each
  sensitive action was independently verified by a second team member before and after
  execution, so no critical step could be taken or missed by an individual.
- **A detailed written runbook.** Every action, expected result, and safety check was
  documented and reviewed in advance. The team executed against the runbook step by step
  rather than improvising.
- **A deliberately staged, two-phase design** to bound any impact. We first validated the
  detection and authorization chain in a mode where **no real pause was possible**, confirming
  the alarm and approval path worked end-to-end. Only then did we run a genuine pause - and
  only on a small set of deliberately chosen, low-traffic networks.
- **Pre-staged, pre-approved recovery.** The "unpause" recovery transactions were prepared and
  signed off **in advance**, ready to execute within minutes. The exercise was reversible at
  all times, with no scrambling required.
- **Advance notice to all stakeholders**, internal and external, so the deliberately realistic
  alerts were never mistaken for a real incident.

---

## What we tested and confirmed

The exercise validated the complete response chain, end to end:

1. **Automated detection.** Hexagate detected a monitored on-chain event and initiated the
   response automatically - no human trigger required.
2. **Secured automation with layered authorization.** The response is orchestrated through a
   secured automation pipeline (built on GitHub Actions). Crucially, **multiple independent
   authorization checks must pass between detection and execution**, so no single component
   can trigger a pause on its own - a deliberate defense-in-depth design. Every gate behaved
   correctly.
3. **Controlled on-chain execution.** With safeguards confirmed, a real pause was executed on
   the selected low-traffic production networks.
4. **Multi-channel alerting.** The team was notified across every channel - email, chat, and
   phone/SMS paging - confirming that responders are reached immediately, day or night.
5. **Rapid, pre-staged recovery.** The networks were unpaused within minutes using the
   pre-approved recovery transactions, returning everything to its normal state.

We also confirmed the system's **fail-safe design**: where a precondition was not met, the
safeguard correctly **declined to act rather than acting incorrectly** - precisely the
behaviour an emergency control must guarantee. Throughout, an internal readiness tool verified
the exact state of every contract before, during, and after the exercise.

---

## Continuous improvement

The core value of a controlled exercise is that it surfaces operational refinements while the
stakes are low - so they are never encountered for the first time during a real incident. This
test did exactly that, and **every improvement identified has since been implemented**:

| Improvement | Status |
|---|---|
| Hardened funding checks across **all** production networks, with an automated guardrail so the pause transaction is always funded. | ✅ Implemented |
| Introduced an **automated weekly readiness check** that continuously verifies the emergency-pause system is correctly configured, funded, and ready. | ✅ Implemented |
| Confirmed and hardened the direct on-chain execution path so the pause runs without delay. | ✅ Implemented |
| Refined alerting so every alert is delivered as its own incident, and reviewed on-call coverage. | ✅ Implemented |
| Strengthened how operational secrets are validated, surfacing any issue well ahead of time. | ✅ Implemented |
| Formalized that a security approver is present for the full duration of every live exercise, and that external auditors are notified in advance. | ✅ Implemented |

The exercise turned a previously one-time validation into an **ongoing, automated assurance
process** - the pause system's readiness is now monitored continuously, not just at test time.

---

## In closing

The most important question - *can LI.FI pause its production contracts to protect user funds
when it matters?* - is answered **yes**. The capability was tested end-to-end in production,
under disciplined controls, and confirmed working. The exercise both proved the core
safeguard and made it stronger. LI.FI treats the security of user funds as a continuous,
evidence-based discipline, and this exercise is one part of that ongoing commitment.

---

## Appendix

### Glossary

- **Emergency pause** - an on-chain control that instantly freezes activity on a smart
  contract to protect user funds during a suspected attack.
- **Four-eyes principle** - a control requiring a second qualified person to independently
  verify each sensitive action, so no critical step is taken by one individual alone.
- **On-chain monitoring** - continuous, automated surveillance of smart-contract activity to
  detect threats in real time.
- **Pre-signed recovery** - recovery transactions prepared and approved in advance by the
  required signers, so they can be executed immediately when needed rather than assembled
  under pressure. LI.FI's most sensitive actions require approval from multiple independent
  signers (a multi-signature scheme).

### About Hexagate

Hexagate, a Chainalysis company, is a real-time on-chain security platform that detects threats

- exploits, key compromises, governance attacks, and phishing - and can trigger automated
responses such as contract pauses. Built on Chainalysis's blockchain intelligence, it monitors
LI.FI's production contracts continuously. Learn more: <https://www.chainalysis.com/product/hexagate/>
