# Contract Deployment Checklist

The following content will guide you through deploying and configuring all smart contracts to a new network (or to deploy a new staging environment).

If you only want to deploy a new diamond contract and use existing deployed facets, please skip to [this section](#deploy-new)

If you want to deploy an immutable diamond, please skip to [this section](#deploy-immutable)

## Prerequisites

1. Prepare your .env file to have the following values set:

**CREATE3_FACTORY_ADDRESS**= 0x93FEC2C00BfE902F733B57c5a6CeeD7CD1384AE1
This needs to be deployed ahead of time on every chain you plan to deploy to. LI.FI has gone ahead and deployed a version of the CREATE3 factory on a handful of chains already.
(can be verified here: [https://github.com/lifinance/create3-factory/tree/main/deployments](https://github.com/lifinance/create3-factory/tree/main/deployments))

**ETH_NODE_URI_\<NETWORK\>**=<add your own RPC link here> (NETWORK being the network you deploy to e.g. MAINNET, POLYGON or BSC)
(e.g. [https://1rpc.io/eth](https://1rpc.io/eth))

**\<NETWORK\>_ETHERSCAN_API_KEY**=<add your own Etherscan API key here>

> > if you deploy to another network, make sure you have both variables set for that specific network. E.g.: **ETH_NODE_URI_GOERLI** and **GOERLI_ETHERSCAN_API_KEY** for deployments to Goerli etc.

**PRODUCTION**=false (set to **true** if you want to deploy to production obviously, but confirm with @Edmund Zynda beforehand)

2. Install required packages

[https://github.com/foundry-rs/foundry](https://github.com/foundry-rs/foundry)

[https://github.com/charmbracelet/gum](https://github.com/charmbracelet/gum)

[https://github.com/stedolan/jq](https://github.com/stedolan/jq)

3. Merge your branch with latest master to make sure you have all the latest addresses stored in your deployments folder

Scripts:

- /scripts/deploy.sh (for deploying any of our contracts)
  - execute with command `./scripts/deploy.sh` in your console
- /scripts/diamond-update.sh (update / add to diamond)
  - execute with command `./scripts/diamond-update.sh` in your console
- /scripts/update-periphery.sh (add new contract to periphery registry)
  - execute with command `./scripts/update-periphery.sh` in your console

## Deploy facet and LiFiDiamond contracts

Deploy (in this order) using `./scripts/deploy.sh`:

- [ ] DiamondCutFacet
- [ ] DiamondLoupeFacet
- [ ] OwnershipFacet
- [ ] DexManagerFacet
- [ ] AccessManagerFacet
- [ ] WithdrawFacet
- [ ] PeripheryRegistryFacet
- [ ] **LiFiDiamond**
- [ ] <a name="update-core"></a>Update the diamond contract using `./scripts/diamond-update.sh`:
  - select “UpdateCoreFacets”
- <a name="update-sigs"></a>Run:
  - [ ] `./scripts/sync-dexs.sh`
  - [ ] `./scripts/sync-sigs.sh`

## <a name="add-bridge"></a>Bridges / Facets

1. For each facet that you want to deploy and add to the diamond, run first the deploy script (i.e. `./scripts/deploy.sh`) and, upon success, the update script (i.e.`./scripts/diamond-update.sh`)
   (you will be prompted to select a network and facet to deploy/update)
2. Available facets (\* = ETH Mainnet only)
   - Across
   - Amarok
     - ❗️needs to be initialized with chainId ↔ domainId mappings after deployment
   - Axelar
   - Arbitrum\*
   - CBridge
   - GenericSwap
   - Gnosis\*
   - Gravity
   - Hop
   - HopFacetOptimized
     - ❗️maxApproval calls
   - Hyphen
   - Multichain
   - NXTP
   - Omni\*
   - Optimism\*
   - Polygon\*
   - Stargate

## <a name="add-periphery"></a>Periphery

1. For each periphery contract that you want to deploy and add to the diamond run the deploy script (i.e. `./scripts/deploy.sh`)
   (you will be prompted to select a network and facet to deploy/update) 1. ERC20 2. AxelarExecutor 3. Executor 4. Receiver 5. FeeCollector 6. RelayerCBridge
2. After you deployed all periphery contracts, execute the update script (i.e.`./scripts/update-periphery.sh`) for each contract to be registered
   (you will be prompted to select a network and contract to register)

---

---

## <a name="deploy-new"></a>Deploy a new diamond (e.g. staging) and add already deployed facets

(find detailed instructions for each step above)

- [ ] deploy new diamond contract
- [ ] Update core facets as described [here](#update-core)
- [ ] run `./scripts/sync-dexs.sh`
- [ ] run `./scripts/sync-sigs.sh`
- [ ] add bridge facets as needed (as described [here](#add-bridge))
  - ❗️dont forget any required configuration calls

---

---

## <a name="deploy-immutable"></a>Deploy immutable diamond

- [ ] Run this script `./scripts/deploy.sh`, select desired network and option `DeployLiFiDiamondImmutable`
- [ ] Update core facets as described [here](#update-core)
- [ ] Sync DEXs and Sigs as described [here](#update-sigs)
- [ ] Deploy bridge facets (if needed) - in most cases we can use the existing deployments
- [ ] add bridge facets as needed (as described [here](#add-bridge))
- [ ] Run facet-specific configuration calls
  1. **Amarok:** add domainIds
  2. **HopFacetOptimized:** run maxApproval calls for tokens
- [ ] Deploy periphery contracts (if needed) - in most cases we can use the existing deployments
- [ ] Add periphery contracts to registry as described [here](#add-periphery)
- [ ] Run script `./scripts/make-diamond-immutable.sh`
  - will transfer Ownership of diamond to address(0)
  - will remove the diamondCut facet so that no further contract changes are possible
- [ ] Update docs
  1. Create an .md file for the immutable contract
  2. Deployed-to-addresses in docs (Gitbook)

When releasing a new version of the immutable diamond, some scripts and files need to be updated, namely:

- deploy.sh
- DeployLiFiDiamondImmutable.s.sol
- UpdateScriptBase.sol
