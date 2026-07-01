# LI.FI custom Semgrep rules

Each rule encodes a structural pattern from a confirmed past finding in
`audit/knowledge/findings.json`. The rule id includes the LF-NNN reference so
findings and rules cross-link.

Run locally:

```bash
semgrep --config=audit/knowledge/semgrep src/
```

In CI: Stage 1 of the security-review workflow includes these rules in the
Semgrep invocation. See EXP-440 architecture diagram.

## Conventions

- One YAML file per rule (`lf-<NNN>-<short-name>.yml`)
- `severity` (rule-level) reflects how confidently a hit is a real bug:
  - `ERROR` → near-certain regression
  - `WARNING` → strong signal, worth manual triage
  - `INFO` → noisy / heuristic
- Each rule's `message` cites the source finding (`LF-NNN`) and a one-line
  description of the pattern
- Rules are conservative by default — better to miss than to flood the PR
  reviewer with false positives. Tune through EXP-484 baseline measurement.

## Maintainership

These are **seed rules**. EXP-487's auto-generation feedback loop will add
rules over time as new findings are confirmed. Hand-authored rules here are
versioned with the corpus.
