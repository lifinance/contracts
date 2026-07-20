---
name: Config file structure
description: How to structure JSON config files in config/ for deployments and deploy scripts
globs:
  - 'config/**/*.json'
  - 'script/deploy/**/*.s.sol'
  - 'script/deploy/resources/deployRequirements.json'
alwaysApply: false # for Cursor
paths:
  - 'config/**/*.json'
  - 'script/deploy/**/*.s.sol'
  - 'script/deploy/resources/deployRequirements.json'
---

## Config File Structure ([CONV:CONFIG-STRUCTURE])

Config files in `config/` (e.g. `garden.json`, `glacis.json`) feed deploy scripts and are validated via `script/deploy/resources/deployRequirements.json` using `configFileName` and `keyInConfigFile`.

### Single parameter for all chains (same key name)

When **one parameter** is used across all networks with the **same key name** (e.g. `htlcRegistry`, `airlift`):

- **Structure: key first, then networks.** Use one top-level key (the parameter name); under it, use network names as keys and their values (e.g. addresses) as values.
- **Order:** List `mainnet` first, then all other networks **alphabetically**.
- **Deploy path:** Scripts and `deployRequirements.json` must use `.<key>.<NETWORK>` (e.g. `.htlcRegistry.mainnet`, `.airlift.zksync`).

Example:

```json
{
  "htlcRegistry": {
    "mainnet": "0x...",
    "arbitrum": "0x...",
    "base": "0x..."
  }
}
```

### Multiple parameters per network

When there are **several parameters per network** (different or multiple keys per network):

- **Structure: network first, then parameters.** Use network names as top-level keys; each network’s value is an object with parameter names and their values.
- **Order:** List `mainnet` first, then all other networks **alphabetically**.
- **Deploy path:** Scripts and `deployRequirements.json` must use `.<NETWORK>.<key>` (e.g. `.mainnet.cBridge`, `.arbitrum.gateway`).

Example:

```json
{
  "mainnet": {
    "cBridge": "0x...",
    "gateway": "0x..."
  },
  "arbitrum": {
    "cBridge": "0x...",
    "gateway": "0x..."
  }
}
```

### Required vs optional per-network values (sparsity)

Decide per key whether `address(0)` is a valid value, and shape the config accordingly:

- **Required (`address(0)` is invalid).** The parameter must be a real, code-bearing contract on every supported chain (e.g. `hop`, `htlcRegistry`, `airlift`). **List every network explicitly** and read it with the strict overload `_getConfigContractAddress(path, key)`, which reverts on zero or non-contract. A missing or zero entry must fail the deploy loudly.
- **Optional (`address(0)` is the normal value).** The parameter is meaningful on only a few chains and legitimately zero everywhere else (e.g. Tempo's `tipFeeManager` / `pathUsd`, non-zero only on Tempo). **List only the non-zero networks** — do not enumerate dozens of `0x0000…0000` entries. Read these with `_getOptionalConfigContractAddress(path, key)`, which returns `address(0)` when the key is absent, so a chain omitted from the map deploys with the zero default instead of reverting.

Rationale: `_getConfigContractAddress` reverts on a **missing** key (an absent `readAddress` decodes empty bytes), so an all-zero-but-listed map is not just noise — combined with the fact that `/add-network` does not touch bridge configs, it turns the first deploy on any future chain into a revert on a value that was always meant to be zero. Sparse config for optional keys removes that footgun; explicit listing for required keys keeps a genuinely missing address failing closed. (The bash `checkDeployRequirements` layer already tolerates a missing key when `allowToDeployWithZeroAddress` is `"true"` — set it so for optional keys.)

### Consistency

- When adding or restructuring a config file, update the corresponding deploy script(s) (including `script/deploy/zksync/` when present) and the relevant contract entry in `deployRequirements.json` so `keyInConfigFile` matches the chosen structure (`.<key>.<NETWORK>` vs `.<NETWORK>.<key>`).
