# Setup

Complete setup for the LI.FI smart-contracts repo: the local toolchain
(everyone), plus — for LI.FI developers — access to internal resources (the Safe
proposal MongoDB and deploy infrastructure). The README's Getting Started has
only the quick-start; this is the full guide.

## Prerequisites

- Node.js (v18 or later)
- Bun (latest version)
- Foundry (pinned via `.foundry-version`)
- Git
- Cursor IDE (recommended) or VSCode

## Local development environment

1. Clone the repository:

   ```bash
   git clone https://github.com/lifinance/contracts.git
   cd contracts
   ```

2. Install dependencies:

   ```bash
   bun i
   forge install
   ```

3. Install the pinned Foundry version:

   ```bash
   foundryup --install "$(cat .foundry-version)"
   ```

   The pre-commit hook and CI verify that your installed `forge` matches
   `.foundry-version` and refuse to run on mismatch. To bump the pin, change
   `.foundry-version` in a PR — every workflow and dev environment picks it up
   automatically.

4. Set up environment variables:

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

## Cursor IDE setup

For optimal AI assistance in Cursor IDE:

1. Copy `.cursorrules.example` to `.cursorrules`:

   ```bash
   cp .cursorrules.example .cursorrules
   ```

2. The `.cursorrules` file provides context for AI interactions with our
   codebase. It helps the AI understand:

   - Project structure and conventions
   - Development environment and tools
   - Key files and their purposes
   - Testing and deployment requirements

3. You can customize `.cursorrules` based on your needs, but we recommend keeping
   the core context intact.

## Accessing LI.FI resources (Safe MongoDB & deploy infra)

Deploy and Safe tooling in this repo reads and writes LI.FI infrastructure — most
importantly the **Safe proposal MongoDB** (`sc_private.pendingTransactions`, via
`SC_MONGODB_URI`) used by `propose-to-safe`, `confirm-safe-tx`,
`list-pending-proposals`, and the rollout skills.

As of July 2026 the legacy OpenVPN has been retired. These resources are no
longer reachable by IP whitelisting; access now goes through the **`lifi-connect`**
port-forwarding CLI, authenticated via AWS SSO (Okta). This section gets a fresh
machine — or an agent session — from zero to a working connection.

> Canonical, always-current source (DevOps-owned): **[Accessing Resources with
> Port Forwarding](https://app.notion.com/p/lifi/Accessing-Resources-with-Port-Forwarding-396f0ff14ac78098bf13f06d4a428845)**.
> This section is the repo-local summary; if the two disagree, the Notion doc
> wins — please open a PR to reconcile.

### Access prerequisites

All available via Homebrew:

```bash
brew install awscli kubectl jq yq go
```

- `awscli` — AWS SSO login and the EKS token helper
- `kubectl` — `lifi-connect` port-forwards through the EKS clusters
- `jq`, `yq` — used by `generate-kubeconfig.sh` (needs the mikefarah `yq`, i.e. `brew install yq`)
- `go` — only needed if `lifi-connect` builds from source (no prebuilt release for your platform)

### Human access setup

#### 1. AWS access (Okta SSO)

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

#### 2. Kubernetes contexts

`lifi-connect` needs one kubectl context per cluster in `~/.kube/config`:

```bash
cd lifi-ops
./generate-kubeconfig.sh      # backs up the existing kubeconfig, then rebuilds it
```

#### 3. Install lifi-connect

```bash
cd lifi-ops/lifi-connect
./install.sh                  # installs to ~/.local/bin/lifi-connect
lifi-connect update           # keep it current when DevOps ship fixes
```

#### 4. Open a tunnel and point SC_MONGODB_URI at it

For work that touches the Safe proposal database (production):

```bash
awslogin                              # if the 8h AWS session has expired
lifi-connect prod smart-contracts     # foreground; leave it running in its own tab
```

`lifi-connect` prints a **static** `localhost:<port>` for the `smart-contracts`
MongoDB (the port is stable across sessions) and the exact connection string to
use. Set `SC_MONGODB_URI` in your `.env` to that host, keeping the Mongo
**credentials from your 1Password vault** (the tunnel provides the network path,
not authentication):

```text
SC_MONGODB_URI="mongodb://<user>:<pass>@localhost:<port>/?directConnection=true&tls=false"
```

`directConnection=true` is required: without it the driver tries to discover
replica-set members by their in-cluster hostnames (which aren't tunneled) and
fails with a server-selection timeout. `tls=false` because TLS terminates at the
tunnel. Run `lifi-connect list` to see every cluster and endpoint.

The tunnel dies when your AWS SSO session expires — re-run `awslogin` and restart
`lifi-connect`.

**Convenience wrapper.** To avoid starting the tunnel by hand each time, wrap any
Safe/Mongo command — it ensures the tunnel is up (starting it if needed, then
waiting for the port) before running:

```bash
bun run safe:tunnel                       # just ensure the tunnel, then exit
bun run safe:tunnel bun confirm-safe-tx   # ensure the tunnel, then run the script
```

The wrapper never starts a production tunnel silently from inside a signing
script — it's an explicit, opt-in convenience (see `script/deploy/safe/with-safe-tunnel.sh`).

### Agent access

Running an automated agent (Claude Code, Cursor, etc.) against this repo? The
agent-specific guidance — what an agent must **not** do, and how commands differ
in a non-interactive shell — is in **[Setup-agents.md](Setup-agents.md)**. The
steps above are the human path.
