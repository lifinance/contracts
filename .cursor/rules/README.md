# Cursor Rules Structure

This directory contains rule files (`.mdc` format) that guide the AI assistant's behavior when working with this codebase.

## Rule File Naming

Rules are numbered for ordering:

- `00-*`: Always-applied global rules (context monitoring, guardrails)
- `05-*`: Language/framework baseline rules (Solidity basics)
- `10-*`: Production code rules (contracts, interfaces)
- `11-*`: Specific component rules (facets)
- `12-*`: Test rules
- `15-*`: Architecture rules
- `16-*`: Security rules
- `17-*`: Performance rules (gas)
- `18-*`: Testing discipline
- `20-*`: Script rules (Solidity)
- `30-*`: TypeScript rules
- `40-*`: Bash rules
- `99-*`: Final checks (completion)

## Rule File Format

Each rule file uses MDC (Markdown with frontmatter):

```markdown
---
name: Rule name
description: Brief description
globs:
  - 'pattern/**/*.sol'
alwaysApply: true # Optional, only for critical global rules
---

Rule content here...
```

## Rule Activation

- **alwaysApply: true**: Rule is always included in context (use sparingly)
- **globs**: Rule activates when files matching patterns are referenced
- **@dependencies**: Rules can reference other rules using `@filename.mdc` syntax

## Conventions Integration

Rules reference conventions via `[CONV:*]` anchors that map to:

- `docs/conventions_digest/*.md` - Short, machine-readable convention digests
- `conventions.md` - High-level architectural guide

See `docs/conventions_digest/_index.json` for anchor mappings.

## Best Practices

1. **Keep rules focused**: One concern per rule file
2. **Reference, don't repeat**: Use `[CONV:*]` anchors instead of duplicating convention text
3. **Use specific globs**: Target file types precisely to avoid unnecessary activation
4. **Minimize alwaysApply**: Only use for truly global rules (00-_, 99-_)
5. **Optimize for tokens**: Be concise; reference external docs rather than including full text

## Context Management

- `00-context-monitor.mdc`: Monitors context window usage, warns when approaching limits, and handles information rollover/handoff

## Adding New Rules

1. Choose appropriate number range (see naming above)
2. Create `.mdc` file with frontmatter
3. Define specific globs (avoid `**/*` unless truly global)
4. Reference conventions via `[CONV:*]` anchors
5. Test that rule activates appropriately
6. Document in this README if adding new category

## Transaction Analysis

Special handling for transaction analysis:

- `.cursor/rules/transaction_analysis.cursorrules.mdc`: Activation gate and RPC policy
- `.cursor/prompts/transaction_analysis.md`: Detailed analysis playbook (only loaded when gate activates)

This ensures the verbose analysis prompt only loads when actually analyzing transactions.
