# Setup — Accessing LI.FI Resources (Safe MongoDB & deploy infra)

Deploy and Safe tooling in this repo reads and writes LI.FI infrastructure —
most importantly the **Safe proposal MongoDB** (`sc_private.pendingTransactions`,
via `SC_MONGODB_URI`) used by `propose-to-safe`, `confirm-safe-tx`,
`list-pending-proposals`, and the rollout skills.

As of July 2026 the legacy OpenVPN has been retired. These resources are no
longer reachable by IP whitelisting; access now goes through the **`lifi-connect`**
port-forwarding CLI, authenticated via AWS SSO (Okta). This guide gets a fresh
machine — or an agent session — from zero to a working connection.

> Canonical, always-current source (DevOps-owned): **[Accessing Resources with
> Port Forwarding](https://app.notion.com/p/lifi/Accessing-Resources-with-Port-Forwarding-396f0ff14ac78098bf13f06d4a428845)**.
> This doc is the repo-local summary; if the two disagree, the Notion doc wins —
> please open a PR to reconcile.

## Prerequisites

All available via Homebrew:

```bash
brew install awscli kubectl jq yq go
```

- `awscli` — AWS SSO login and the EKS token helper
- `kubectl` — `lifi-connect` port-forwards through the EKS clusters
- `jq`, `yq` — used by `generate-kubeconfig.sh` (needs the mikefarah `yq`, i.e. `brew install yq`)
- `go` — only needed if `lifi-connect` builds from source (no prebuilt release for your platform)

## Human setup

### 1. AWS access (Okta SSO)

```bash
git clone git@github.com:lifinance/lifi-ops.git
cd lifi-ops
./generate-aws-config.sh DeveloperAccess     # opens a browser → log in with Okta
```

Pick any account/role when prompted — the script configures all your profiles.
Add the session-renewal alias (sessions last 8 hours):

```bash
echo 'alias awslogin="aws sso login --sso-session LIFI"' >> ~/.zshrc && source ~/.zshrc
```

Renew any time with `awslogin`. Verify:

```bash
aws sts get-caller-identity --profile shared-services-dev
```

### 2. Kubernetes contexts

`lifi-connect` needs one kubectl context per cluster in `~/.kube/config`:

```bash
cd lifi-ops
./generate-kubeconfig.sh      # backs up the existing kubeconfig, then rebuilds it
```

### 3. Install lifi-connect

```bash
cd lifi-ops/lifi-connect
./install.sh                  # installs to ~/.local/bin/lifi-connect
lifi-connect update           # keep it current when DevOps ship fixes
```

### 4. Open a tunnel and point SC_MONGODB_URI at it

For work that touches the Safe proposal database (production):

```bash
awslogin                              # if the 8h AWS session has expired
lifi-connect prod smart-contracts     # foreground; leave it running in its own tab
```

`lifi-connect` prints a **static** `localhost:<port>` for the `smart-contracts`
MongoDB (the port is stable across sessions). Set `SC_MONGODB_URI` in your `.env`
to that host, keeping the Mongo **credentials from your 1Password vault** (the
tunnel provides the network path, not authentication):

```text
SC_MONGODB_URI="mongodb://<user>:<pass>@localhost:<port>/?<options>"
```

Run `lifi-connect list` to see every cluster and endpoint. The tunnel dies when
your AWS SSO session expires — re-run `awslogin` and restart `lifi-connect`.

## Agent setup

An automated agent (e.g. Claude Code) shares the same underlying tooling but
**cannot perform the interactive steps** — those stay with the human at the
keyboard. Concretely:

| Step | Who | Why |
|---|---|---|
| Browser-based Okta SSO (`generate-aws-config.sh`, `awslogin`) | **Human** | Requires an interactive browser + MFA the agent can't drive |
| Mongo credentials for `SC_MONGODB_URI` | **Human** | Live in 1Password; agents must not access 1Password |
| Opening a **production** tunnel (`lifi-connect prod …`) | **Human** | Persistent prod channel — gated behind explicit human approval |
| Installing CLIs, running `generate-kubeconfig.sh`, editing repo files | Agent OK | Non-interactive, no secrets |

Notes for agents running commands through a non-interactive shell:

- **Shell aliases don't exist** in a non-interactive shell. Use the full command,
  not the alias: `aws sso login --sso-session LIFI` (there is no `awslogin`).
- **PATH is not the login shell's.** Prepend the tool locations explicitly:
  `export PATH="$HOME/.foundry/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"`
  (`~/.local/bin` is where `lifi-connect` installs).
- **Assume the human has already authenticated and started the tunnel.** If a
  Safe/Mongo script fails, it now throws an actionable error naming
  `lifi-connect prod smart-contracts` — surface that to the human rather than
  attempting the browser login or opening the prod tunnel yourself.
- **Never** read `.env` secret values, invoke the 1Password `op` CLI, or write
  the resolved `SC_MONGODB_URI` back into the repo.
