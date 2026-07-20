# Setup for agents

Setup guidance specific to automated agents (Claude Code, Cursor, etc.) working
in this repo. The full human-oriented setup — toolchain, Cursor IDE, and the
step-by-step for internal resource access — lives in [Setup.md](Setup.md); this
page is only what *differs* for an agent, so you don't have to read the
interactive human steps to know how to behave.

## What an agent must not do

These steps require a human at the keyboard. Hand them off — don't attempt them:

| Step | Why it's human-only |
|---|---|
| Browser-based Okta SSO (`generate-aws-config.sh`, `awslogin`) | Needs an interactive browser + MFA |
| Supplying Mongo credentials for `SC_MONGODB_URI` | Live in 1Password — never touch 1Password or the `op` CLI |
| Opening a **production** tunnel (`lifi-connect prod …`) | Persistent prod channel, gated behind explicit human approval |

Installing CLIs, running `generate-kubeconfig.sh`, and editing repo files are
fine — non-interactive and secret-free. The commands themselves are in
[Setup.md → Accessing LI.FI resources](Setup.md#accessing-lifi-resources-safe-mongodb--deploy-infra);
this page doesn't repeat them.

## Running commands in a non-interactive shell

- **Shell aliases don't exist.** Use `aws sso login --sso-session LIFI`, not the
  `awslogin` alias.
- **PATH is not the login shell's.** Prepend tool locations explicitly:
  `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"`
  (`~/.local/bin` is where `lifi-connect` installs).
- **Assume the human has already authenticated and started any needed tunnel.**
  Don't run the browser login or open the prod tunnel yourself.

## When a Safe/Mongo script fails

`getSafeMongoCollection()` (in `script/deploy/safe/safe-utils.ts`) throws a
fail-fast, actionable error naming `lifi-connect prod smart-contracts` when the
tunnel is down. Surface that to the human rather than trying to fix access
yourself. Never read `.env` secret values, and never write a resolved
`SC_MONGODB_URI` back into the repo.
