<!--
  External partner report — drafted against:
  docs/superpowers/specs/2026-06-16-emergency-pause-external-report-design.md
  This markdown is the finalized text. LI.FI branding + PDF production is the downstream step.
-->

# Production Emergency-Response Exercise

## Confirming LI.FI's Ability to Protect User Funds

*On 28 May 2026, LI.FI conducted a full end-to-end test of its automated emergency-pause
capability in live production — and confirmed it works exactly as designed.*

| | |
|---|---|
| **Prepared by** | LI.FI Smart Contract Team |
| **Exercise date** | 28 May 2026 |
| **Audience** | Partners and integrators conducting security due diligence on LI.FI |
| **Status** | Final |

---

## Executive summary

LI.FI operates an automated safeguard that can **pause the LI.FI Diamond — its core
cross-chain bridging and swapping protocol — within moments of a threat being detected**,
freezing activity to protect user funds. The LI.FI Diamond is monitored around the clock by
Hexagate, a Chainalysis company, and the emergency-pause system is designed so that this
monitoring can trigger the response **automatically**, without waiting for a human at a
keyboard.

On **28 May 2026** we tested that entire capability end-to-end, in production. The exercise
was meticulously planned around a detailed written runbook, executed under a strict
four-eyes principle, and deliberately staged so that it remained reversible at every step.

**The result: the capability works.** Threat detection, authorization, the built-in safety
stops, multi-channel team alerting, and rapid recovery all performed exactly as designed. As
intended with any rigorous exercise, we identified a small set of operational refinements —
and have since implemented all of them, further strengthening an already-working system.

---

## Why this capability matters

The LI.FI Diamond moves real user funds across chains. If it ever came under attack, the most
important defensive action is the ability to **pause it instantly** — freezing activity before
an attacker can cause harm, and buying responders time to act.

A pause capability is only meaningful if it is **fast, reliable, and continuously ready**. It
cannot depend on someone happening to be awake and online: it must be backed by continuous
monitoring that can detect a threat and trigger the response automatically, and it must be
proven under realistic conditions so there are no surprises when it matters most. This
exercise was designed to demonstrate exactly that.

---

## How the emergency response works

The protection is an end-to-end chain. Each stage hands off to the next, and several
independent checks must pass before the protocol is ever touched:

```mermaid
flowchart TD
    A["1 · Detection — Hexagate monitors the LI.FI Diamond for on-chain threats"] --> B["2 · Secured automation — a pipeline with multiple independent authorization gates"]
    B --> C["3 · Controlled execution — the LI.FI Diamond is paused on-chain"]
    C --> D["4 · Recovery — pre-approved, pre-signed transactions restore normal operation"]
    B -. in parallel .-> E["Alerting — the team is notified by email, chat, and phone/SMS"]
```

1. **Detection.** Hexagate continuously monitors the LI.FI Diamond for anomalous or malicious
   on-chain activity.
2. **Secured automation.** A detection is handed to a secured automation pipeline (built on
   GitHub Actions) that orchestrates the response. **Multiple independent authorization checks
   must pass before anything executes**, so no single component can trigger a pause on its
   own — a deliberate defense-in-depth design.
3. **Controlled on-chain execution.** Once the checks pass, the LI.FI Diamond is paused
   on-chain, freezing activity.
4. **Alerting (in parallel).** The team is notified across multiple channels — email, chat,
   and phone/SMS paging — so responders engage immediately, day or night.
5. **Recovery.** Pre-approved, pre-signed recovery transactions let the team safely restore
   normal operation within minutes.

---

## How we ensured a safe, controlled exercise

Testing an emergency control in live production demands discipline. We applied several
independent layers of control:

- **A four-eyes principle, executed as a team.** The entire smart contract team, together with
  a member of the security team, ran the exercise in a single shared session — working through
  every step of the runbook together rather than any one person acting alone. Each sensitive
  action was independently verified by a second team member before and after execution, so no
  critical step could be taken, or missed, by an individual.
- **A detailed written runbook.** Every action, its expected result, and each safety check was
  documented and reviewed in advance. The team executed against the runbook step by step rather
  than improvising.
- **A deliberately staged, two-phase design** to bound any impact. We first validated the
  detection and authorization chain in a mode where **no real pause was possible**, confirming
  the alarm and approval path worked end-to-end. Only then did we run a genuine pause — and only
  on a small set of deliberately chosen, low-traffic networks.
- **Pre-staged, pre-approved recovery.** The recovery ("unpause") transactions were prepared
  and signed off **in advance** by the required signers, ready to execute the moment they were
  needed — so reversing the pause required no scrambling.
- **Advance notice to all stakeholders**, internal and external — including our external
  auditors — so the deliberately realistic alerts were never mistaken for a real incident.

---

## What we tested and confirmed

Following the runbook, we exercised the full chain shown above and confirmed every stage
performed as designed:

- **Detection and automated dispatch** — a Hexagate monitor detected a designated on-chain
  event and initiated the response automatically, with no human trigger, exercising the exact
  automated path a real production threat detection would follow.
- **Authorization** — every independent authorization gate behaved correctly; no single
  component could act on its own.
- **Controlled execution** — the LI.FI Diamond was paused on-chain on the selected low-traffic
  networks.
- **Alerting** — the team was reached across every channel (email, chat, and phone/SMS paging),
  confirming responders would be engaged day or night.
- **Recovery** — the affected networks were restored to normal operation within minutes using
  the pre-approved recovery transactions, returning everything to its pre-test state.

We also confirmed the system's **fail-safe design**: where a precondition was not met, the
safeguard correctly **declined to act rather than acting incorrectly** — precisely the
behaviour an emergency control must guarantee, and one of the most valuable assurances this
exercise produced. Throughout, an internal readiness tool verified the exact state of the
protocol on every network before, during, and after the exercise.

---

## Continuous improvement

The core value of a controlled exercise is that it surfaces operational refinements while the
stakes are low — so they are never encountered for the first time during a real incident. This
test did exactly that, and **every improvement identified has since been implemented**:

| Improvement | Status |
|---|---|
| Hardened funding checks across **all** production networks, with an automated guardrail ensuring the pause transaction is always funded. | ✅ Implemented |
| Introduced an **automated weekly readiness check** that continuously verifies the emergency-pause system is correctly configured, funded, and ready. | ✅ Implemented |
| Confirmed and hardened the direct on-chain execution path so the pause runs without delay. | ✅ Implemented |
| Refined alerting so every alert is delivered as its own distinct incident, and reviewed on-call coverage so every responder is reachable. | ✅ Implemented |
| Strengthened how operational secrets are validated, surfacing any issue well ahead of time. | ✅ Implemented |
| Formalized that a security approver is present for the full duration of every live exercise, and that external auditors are notified in advance as a required step. | ✅ Implemented |

The exercise turned a previously one-time validation into an **ongoing, automated assurance
process** — the protocol's emergency-pause readiness is now monitored continuously, not just
at test time.

---

## In closing

The most important question — *can LI.FI pause the LI.FI Diamond to protect user funds when it
matters?* — is answered **yes**. The capability was tested end-to-end in live production, under
disciplined controls, and confirmed working. The exercise both proved the core safeguard and
made it measurably stronger. LI.FI treats the security of user funds as a continuous,
evidence-based discipline, and this exercise is one part of that ongoing commitment.

---

## Appendix

### Glossary

- **LI.FI Diamond** — LI.FI's core cross-chain protocol: the on-chain smart contracts that
  power LI.FI's bridging and swapping, deployed across many networks. This report concerns the
  LI.FI Diamond specifically.
- **Emergency pause** — an on-chain control that instantly freezes activity on the protocol to
  protect user funds during a suspected attack.
- **Four-eyes principle** — a control requiring a second qualified person to independently
  verify each sensitive action, so no critical step is taken by one individual alone.
- **On-chain monitoring** — continuous, automated surveillance of smart-contract activity to
  detect threats in real time.
- **Pre-signed recovery** — recovery transactions prepared and approved in advance by the
  required signers, so they can be executed immediately when needed rather than assembled under
  pressure. LI.FI's most sensitive actions require approval from multiple independent signers
  (a multi-signature scheme).

### About Hexagate

Hexagate, a Chainalysis company, is a real-time on-chain security platform that detects
threats — exploits, key compromises, governance attacks, and phishing — and can trigger
automated responses such as contract pauses. Built on Chainalysis's blockchain intelligence,
it monitors the LI.FI Diamond continuously. Learn more:
<https://www.chainalysis.com/product/hexagate/>
