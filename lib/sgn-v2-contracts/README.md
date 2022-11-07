# SGN Contracts

Contracts for the Celer State Guardian Network (SGN) V2.

### Run unit tests

```sh
yarn test
```

### Benchmark gas cost

```sh
yarn report-gas:benchmark
yarn report-gas:summary
```

Check `reports/gas_usage`.

### Update contract sizes

```sh
yarn size-contracts
```

Check `reports/contract_sizes.txt`.

## Deployments

### Deployment Management

Contract deployments are tracked by hardhat through the files under ./deployments directory on deployment branches.

To deploy newest contracts to mainnet, staging, or testnet chains:

1. `git checkout mainnet-deployment|staging-deployment|testnet-deployment`, correspondingly
2. `git merge main` into the deployment branch
3. deploy the contracts
4. push the deployments file changes

If any contracts (e.g. libraries) are used for both mainnet and staging, follow the step above to deploy them on staging chains first, then cherry-pick the commit containing ONLY the deployment changes of these shared contracts to `mainnet-deployment`. Please be cautious with file changes when doing such operation.

Rules:

1. ./deployments should NOT exist on main branch
2. only merge main into the deployment branches
3. only change the ./deployments directory on deployment branches so that there will always be no conflicts when merge main

### Deploy contracts

1. `cp .env.template .env`, then ensure all environment variables are set in `.env`.

2. Replace `INFURA-PROJECT-ID` suffix of the network endpoint in `.env`, that you're going to use.

3. Add private key of your account that would be used, in `.env`. Refer to `hardhat.config.ts` for env param key.

4. Deploy SGN and Staking contracts:

```sh
hardhat deploy --network <network> --tags SGNStaking
```

Deploy Bridge contract:

```sh
hardhat deploy --network <network>  --tags Bridge
```

Deploy OriginalTokenVault contract:

Make sure to set ORIGINAL_TOKEN_VAULT_SIGS_VERIFIER in .env to the Bridge address when deploying.
Such as:
ORIGINAL_TOKEN_VAULT_SIGS_VERIFIER=0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22

Where 0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22 is the Bridge contract address

```sh
hardhat deploy --network <network>  --tags OriginalTokenVault
```

Deploy PeggedTokenBridge contract:

Make sure to set ORIGINAL_TOKEN_VAULT_SIGS_VERIFIER in .env to the Bridge address when deploying.
Such as:

PEGGED_TOKEN_BRIDGE_SIGS_VERIFIER=0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22

Where 0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22 is the Bridge contract address

```sh
hardhat deploy --network <network>  --tags PeggedTokenBridge
```

Deploy OriginalTokenVaultV2 contract:

Make sure to set ORIGINAL_TOKEN_VAULT_SIGS_VERIFIER in .env to the Bridge address when deploying.
Such as:

ORIGINAL_TOKEN_VAULT_SIGS_VERIFIER=0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22

Where 0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22 is the Bridge contract address

```sh
hardhat deploy --network <network>  --tags OriginalTokenVaultV2
```

Deploy PeggedTokenBridgeV2 contract:

Make sure to set ORIGINAL_TOKEN_VAULT_SIGS_VERIFIER in .env to the Bridge address when deploying.
Such as:

PEGGED_TOKEN_BRIDGE_SIGS_VERIFIER=0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22

Where 0x67E5E3E54B2E4433CeDB484eCF4ef0f35Fe3Fb22 is the Bridge contract address

```sh
hardhat deploy --network <network>  --tags PeggedTokenBridgeV2
```

### Verify contracts on explorers

#### On Etherscan variants via hardhat etherscan-verify

This is the recommended way for most mainnet Etherscan variants.

Make sure the `ETHERSCAN_API_KEY` is set correctly in `.env`.

```sh
hardhat etherscan-verify --network <network> --license "GPL-3.0" --force-license
```

#### On Etherscan variants via solt

This is useful since most testnet Etherscan variants don't offer verification via the API.

1. Generate the standard JSON input files:

```sh
source scripts/solt.sh
run_solt_write
```

2. Then try:

```sh
solt verify --license 5 --network <network> solc-input-<contract>.json <deployed address> <contract name>
```

3. If the second step fails, go to Etherscan and manually verify using the standard JSON input files.

#### On Blockscout variants via sourcify

This is used if the Blockscout variant requires "Sources and Metadata JSON".

```sh
hardhat sourcify --network <network>
```

#### On Blockscout variants via flattened source files

This is used if the Blockscout variant requires a single source file, or in general as a last resort.

1. Flatten the source files:

```sh
hardhat flatten <path-to-contract> > flattened.sol
```

2. Edit `flattened.sol`. Remove the duplicate `SPDX-License-Identifier` lines, keeping a single copy of

```
// SPDX-License-Identifier: GPL-3.0-only
```

and submit to Blockscout.

Sometimes you also need to remove the duplicate `pragma solidity` lines.

## Upgradable contract via the proxy pattern

### How it works

proxy contract holds state and delegatecall all calls to actual impl contract. When upgrade, a new impl contract is deployed, and proxy is updated to point to the new contract. below from [openzeppelin doc](https://docs.openzeppelin.com/upgrades-plugins/1.x/proxies#upgrading-via-the-proxy-pattern)

```
User ---- tx ---> Proxy ----------> Implementation_v0
                     |
                      ------------> Implementation_v1
                     |
                      ------------> Implementation_v2
```

### Add upgradable contract

To minimize code fork, we add a new contract that inherits existing contract, eg. `contract TokenUpgradable is Token`. Next we need to ensure that all states set in Token contract constructor (and its parent contracts) must be settable via a separate normal func like `init`. This will allow Proxy contract to delegeteCall init and set proper values in Proxy's state, not the impl contract state. See MintSwapCanonicalTokenUpgradable.sol for example. We also need to either shadow Ownable._owner because when proxy delegateCall, in proxy state, Ownable._owner is not set and there is no other way to set it. Or use our own Ownable.sol which has internal func initOwner

### Add deploy scripts

add a new ts file for deploy, in deploy options, add proxy section, make sure the methodName and args match actual upgradable contract

```ts
proxy: {
    proxyContract: "OptimizedTransparentProxy",
      execute: {
        // only called when proxy is deployed, it'll call Token contract.init
        // with proper args
        init: {
          methodName: 'init',
          args: [
            process.env.MINT_SWAP_CANONICAL_TOKEN_NAME,
            process.env.MINT_SWAP_CANONICAL_TOKEN_SYMBOL]
        }
      }
}
```

see deploy/pegged/tokens/008_mint_swap_canonical_token_upgradable.ts for example

### Deploy and upgrade

hardhat deploy plugin tries to be smart and deploy ProxyAdmin only once for each chain, deploy impl contract then proxy contract
