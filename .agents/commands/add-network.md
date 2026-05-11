---
name: add-network
description: Add a new network to the codebase (networks.json, foundry.toml, permit2Proxy.json, gaszip.json, bridge configs; do not mutate global.json for per-network Permit2/GasZip; target state via scriptMaster)
usage: /add-network [networkKey] — inputs manually or via CSV of chain team form responses; optionally permit2 address, gasZip short ID and router address
---

# Add Network Command

**Usage**: `/add-network` or `/add-network <networkKey>`

Collect required inputs (manually or from a **CSV** of chain team form responses), validate them and contract addresses with `cast code`, then update config files. For any contract address (multicall, Permit2, Gas.zip router, bridge contracts), run `cast code <address> --rpc-url <rpcUrl>`; if result is `0x` or empty, warn and do not add or ask for the correct address.

**Order**: (1) Validate all inputs and addresses; (2) Update configs. Validation can run in parallel (RPC, cast code, Etherscan V2 chainlist, Gas.zip inbound page, deployer/pauser balances). Config updates can run in parallel across files.

---

## Step 1: Collect and validate inputs

**Sources**: (A) CSV path from user (one row per network; if multiple rows, ask which) or (B) manual entry. CSV as base; manual overrides. Normalize: trim whitespace; chainId integer; addresses `0x` + 40 hex; empty/placeholder (TBD, N/A, "not deployed") = missing.

**Required**: networkKey, chainId, nativeAddress, wrappedNativeAddress, nativeCurrency, rpcUrl, verificationType, explorerUrl, explorerApiUrl.

**Optional (defaults)**: status `"active"`, type `"mainnet"`, multicallAddress `0xcA11bde05977b3631167028862bE2a173976CA11` (must have code), safeAddress `""`, create3Factory `""` (omit key entirely when isZkEVM is true), isZkEVM `false`, deployedWithEvmVersion / deployedWithSolcVersion from foundry.toml, permit2Address `0x000000000022D473030F116dDEE9F6B43aC78BA3`, gasZipChainId / gasZipRouterAddress (Step 6).

**CSV column mapping** (LI.FI form): chainId ← Chain ID; networkKey ← Chain Name (lowercase, no spaces); rpcUrl ← Public RPC URL; explorerUrl ← Recommended block explorer URL:; verificationType ← What is the type of your recommended block explorer? (etherscan|blockscout|Routescan|Custom / Hemera's Social Scan / etc. → custom); nativeCurrency ← Symbol of native token; nativeAddress ← Address / Representation of native token (L1 → `0x0...0` if NA); wrappedNativeAddress ← Address of wrapped native token; multicallAddress ← Address of the Multicall3 contract (if deployed); permit2Address ← Address of the Permit2 contract (if deployed); gasZipRouterAddress ← Address of Gas.Zip Deposit V1 (if deployed); isZkEVM ← Is your chain a zkEVM chain type? (Yes→true). **explorerApiUrl**: not in form — use Etherscan V2 URL if chainId in chainlist, else from explorer type/docs. **Bridges**: column 40 (free text), 41–63 (checkboxes), 65 (addresses).

**Validation**: Warn on missing required, bad format, unknown verificationType. Check Etherscan V2 chainlist; RPC chainId match; Gas.zip inbound for chainId; `cast code` for multicall, Permit2, Gas.zip router; **always** `cast balance` deployerWallet and pauserWallet from `config/global.json` and warn if zero/low. Summarize values and warnings; ask user to confirm before Step 2.

**verificationType** (foundry.toml): etherscan | blockscout | zksync | oklink | sourcify | routescan | custom.

---

## Step 2: `config/networks.json`

Insert new network **alphabetically** (mainnet first, then A–Z). Fields: name, chainId, nativeAddress, nativeCurrency, wrappedNativeAddress, status `"active"`, type `"mainnet"`, rpcUrl, verificationType, explorerUrl, explorerApiUrl, multicallAddress (only if has code), safeAddress `""`, gasZipChainId (Step 6), isZkEVM, deployedWithEvmVersion, deployedWithSolcVersion; for non-zkEVM networks only include create3Factory (use `""` until deployed, or the factory address). **Omit the create3Factory key entirely for zkEVM entries** (do not set it to `""`). Confirm multicall has code; if not, abort or ask for correct address.

---

## Step 3: `foundry.toml`

- **RPC**: `[rpc_endpoints]` add `{networkKey} = "${ETH_NODE_URI_{NETWORK_KEY}}"` (alphabetical).
- **DRPC (if network is on chainlist)**: (1) Open https://drpc.org/chainlist and find the network; (2) extract the DRPC chain name (slug, e.g. `ethereum`, `bsc`); (3) construct the URL prefix `https://<slug>.drpc.org/`; (4) ask the user to attach their API key (to form the complete URL); (5) print the command for them using the **all-lowercase networkKey** (e.g. `optimismsepolia`, not `optimismSepolia` — matching the convention in config/networks.json): `bun add-network-rpc --network <networkKey> --rpc-url <complete URL>`; (6) after storing in MongoDB, run `fetch-rpcs` to populate `.env`. Do **not** manually edit `.env` — it is populated from MongoDB via `fetch-rpcs`.
- **Etherscan**: If chain in https://api.etherscan.io/v2/chainlist, add `{networkKey} = { key = "${MAINNET_ETHERSCAN_API_KEY}", url = "https://api.etherscan.io/v2/api?chainid={chainId}", chain = "{chainId}" }`. Else use explorerApiUrl + verificationType; for blockscout/zksync/oklink/sourcify/custom add `verifier = "<type>"` and appropriate key. Insert alphabetically.

---

## Step 4: Target state

Do **not** run target state parsing from the command. Tell the user to add the new network to the production target state spreadsheet (if needed), then run **`./script/scriptMaster.sh`** → use case **10) Create updated target state from Google Docs** → **2) One specific network** → select the new network. `_targetState.json` is updated by that script; do not edit it manually.

---

## Step 5: Permit2 — `config/permit2Proxy.json` only (do not edit `config/global.json`)

Default Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`. `cast code` on chain: if code exists, add `"<networkKey>": "<permit2Address>"` to `config/permit2Proxy.json` (alphabetically). If no code: do **not** add the new network to permit2Proxy.json (omit it); deployment will skip Permit2Proxy for this network. **Do not** remove Permit2Proxy from corePeriphery in `config/global.json` — global.json is shared; keep omissions local to per-network config.

---

## Step 6: Gas.zip — `config/gaszip.json` and `config/networks.json` only (do not edit `config/global.json`)

Source: https://dev.gas.zip/gas/chain-support/inbound. On that page, use the address from the **"Inbound: Contract Forwarder"** table (do **not** use the "Inbound: Direct Forwarder" table). If available: set gasZipChainId on network in networks.json; add that router address to `config/gaszip.json` under gasZipRouters (alphabetically); `cast code` router and warn if no code. If not available: set gasZipChainId `0` (or omit) for the new network in networks.json; do **not** add the new network to gaszip.json; deployment will skip GasZip for this network. **Do not** remove GasZipFacet or GasZipPeriphery from `config/global.json` — global.json is shared; keep omissions local to the new network's entry in networks.json and per-network files (gaszip.json).

---

## Step 7: Bridge configs (from CSV columns 40, 41–63, 65)

For each bridge indicated (checkbox true or in column 40): get contract address(es) from the bridge’s config file (see links/comments inside each `config/<bridge>.json`), from the bridge config doc, or from column 65; add the new network to that bridge’s `config/<bridge>.json` with the **same structure** as existing entries (insert alphabetically: mainnet first, then A–Z). **Always** run `cast code <address> --rpc-url <rpcUrl>` for every address — if result is `0x` or empty, warn and do not add (or ask for the correct address). List for the user which bridges were updated and which failed validation.

**Form bridge → config**: StargateV2 → stargateV2.json; Relay → relay.json; Across → across.json; Symbiosis → symbiosis.json; Hop, cBridge, Squid, ThorSwap, Mayan, Allbridge, Arbitrum Bridge, Optimism, Polygon Bridge, Omni/Gnosis Bridge, Garden, Eco, Everclear, etc. → corresponding config in `config/`. Gas.zip → Step 6.

### Where to get addresses (examples)

- **StargateV2** (`config/stargateV2.json`): The file documents where to obtain addresses.
  - **EndpointV2**: `LinkToDeployedToAddresses` in the `endpointV2` object → https://docs.layerzero.network/v2/developers/evm/technical-reference/deployed-contracts. Alternative: if you have a TokenMessaging address, call `endpoint()` on it to get EndpointV2.
  - **TokenMessaging**: `LinkToDeployedToAddresses` in the `tokenMessaging` object → https://stargateprotocol.gitbook.io/stargate/v/v2-developer-docs/technical-reference/mainnet-contracts; alternative: https://github.com/stargate-protocol/stargate-v2/tree/main/packages/stg-evm-v2/deployments.
  - Add the new network key under both `endpointV2` and `tokenMessaging` with the addresses; **verify both have code** with `cast code` before adding.

- **Across** (`config/across.json`): The file has comments at the top explaining how to extend it and where to find the SpokePool.
  - **SpokePool**: `LinkToDeployedToAddresses` at the top of the file → https://github.com/across-protocol/contracts/tree/master/deployments. Use the **acrossSpokePool** address for the chain from that repo.
  - Structure per network: `"<networkKey>": { "chainId": <number>, "acrossSpokePool": "0x...", "tokensToApprove": [ ... ] }`. For **new** networks, leave `tokensToApprove` **empty** `[]` (comment: we are not deploying AcrossFacetPacked to new chains, so custom token lists are not needed). **Do not change or remove** existing `tokensToApprove` on already-listed networks. **Verify acrossSpokePool has code** with `cast code` before adding.

For other bridges, open the corresponding `config/<bridge>.json` and follow any `LinkToDeployedToAddresses`, `comment`, or inline docs; then validate every contract address with `cast code`.

---

## Warnings to show

1. Multicall no code → provide valid address or abort.
2. Permit2 no code → not adding to permit2Proxy.json (omit this network); do not edit global.json.
3. Gas.zip router no code → verify address or do not add.
4. Bridge address no code → do not add until correct address; check docs or column 65.
5. Target state → tell user to run scriptMaster use case 10 (do not run from command).
6. Deployer/pauser zero or low balance → fund with native token before deploy; include balances in output.
7. **Changing `config/whitelist.json` is not allowed** — do not add or edit the new network there; whitelist is managed separately.

---

## Checklist

- [ ] Collect/validate inputs; confirm multicall and (if used) Permit2, Gas.zip router have code; run deployer/pauser balance check; summarize and get user confirm.
- [ ] Add network to networks.json (alphabetical).
- [ ] Add RPC + etherscan to foundry.toml; remind ETH_NODE_URI in .env.
- [ ] Tell user to run scriptMaster use case 10 for target state (do not run parsing from command).
- [ ] Permit2: add to permit2Proxy.json if has code; if no code, omit this network from permit2Proxy.json only (do not edit global.json).
- [ ] Gas.zip: add to gaszip.json + networks.json if available; if not, set gasZipChainId = 0 in networks.json and omit from gaszip.json only (do not edit global.json).
- [ ] Bridges: for each indicated, add to bridge config and validate addresses with cast code.

---

## Files modified

| File | Change |
|------|--------|
| `config/networks.json` | New network (alphabetical); set gasZipChainId (or 0) per network. |
| `foundry.toml` | New RPC + etherscan entry. |
| `config/permit2Proxy.json` | New entry **only if** Permit2 has code on this network; omit network if no code. |
| `config/gaszip.json` | New router entry **only if** Gas.zip available on this network; omit if not. |
| `config/global.json` | **Do not edit** for Permit2/GasZip — keep coreFacets/corePeriphery unchanged; omissions are per-network via the above files. |
| `config/<bridge>.json` | New network per indicated bridge (validate addresses). |
| `script/deploy/_targetState.json` | User runs scriptMaster use case 10; do not edit manually. |
| `config/whitelist.json` | **Do not edit** — changing whitelist.json is not allowed; whitelist is managed separately. |
