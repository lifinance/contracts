# Contract Deployment Checklist

The following content will guide you through deploying and configuring all smart contracts to a new network (or to deploy a new staging environment).

If you only want to deploy a new diamond contract and use existing deployed facets, please skip to [this section](#deploy-new)

If you want to deploy an immutable diamond, please skip to [this section](#deploy-immutable)

## Prerequisites

1. Prepare your .env file to have the following values set:

**CREATE3_FACTORY_ADDRESS**= 0x93FEC2C00BfE902F733B57c5a6CeeD7CD1384AE1
This needs to be deployed ahead of time on every chain you plan to deploy to. LI.FI has gone ahead and deployed a version of the CREATE3 factory on a handful of chains already.
(can be verified here: [https://github.com/lifinance/create3-factory/tree/main/deployments](https://github.com/lifinance/create3-factory/tree/main/deployments))

**ETH*NODE_URI*\<NETWORK\>**=<add your own RPC link here> (NETWORK being the network you deploy to e.g. MAINNET, POLYGON or BSC)
(e.g. [https://1rpc.io/eth](https://1rpc.io/eth))

**\<NETWORK\>\_ETHERSCAN_API_KEY**=<add your own Etherscan API key here>

> > if you deploy to another network, make sure you have both variables set for that specific network. E.g.: **ETH_NODE_URI_GOERLI** and **GOERLI_ETHERSCAN_API_KEY** for deployments to Goerli etc.

**PRODUCTION**=false (set to **true** if you want to deploy to production obviously, but confirm with @Edmund Zynda beforehand)

2. Install required packages

[https://github.com/foundry-rs/foundry](https://github.com/foundry-rs/foundry)

[https://github.com/charmbracelet/gum](https://github.com/charmbracelet/gum)

[https://github.com/stedolan/jq](https://github.com/stedolan/jq)

3. Merge your branch with latest master to make sure you have all the latest addresses stored in your deployments folder

Scripts:

- /scripts/scriptMaster.sh (for deploying any of our contracts)
  - execute with command `./scripts/scriptMaster.sh` in your console

## <a name="deploy-new"></a>Deploy a new diamond (e.g. staging) and add already deployed facets

(find detailed instructions for each step above)

- [ ] Run this script `./scripts/scriptMaster.sh` and select `3) Deploy all contracts to one selected network (=new network)`
- [ ] Choose a network and choose `Immutable` as diamond version

---

---

## <a name="deploy-immutable"></a>Deploy immutable diamond

- [ ] Run this script `./scripts/scriptMaster.sh` and select `3) Deploy all contracts to one selected network (=new network)`
- [ ] Choose a network and choose `Immutable` as diamond version
- [ ] Run the `./scripts/scriptMaster.sh` script again and select `5) Execute a script` then `diamondMakeImmutable`
  - will transfer Ownership of diamond to address(0)
  - will remove the diamondCut facet so that no further contract changes are possible
- [ ] Update docs
  1. Create an .md file for the immutable contract
  2. Deployed-to-addresses in docs (Gitbook)

When releasing a new version of the immutable diamond, some scripts and files need to be updated, namely:

- deploy.sh
- DeployLiFiDiamondImmutable.s.sol
- UpdateScriptBase.sol

---

---

## <a name="deploying-contracts"></a>Deploying contracts

- [ ] Run the script `./scripts/scriptMaster.sh` and select `1) Deploy one specific contract to one network`
- [ ] Choose the network
- [ ] Choose the contract you want to deploy and choose to add it to the `Mutable`, `Immutable` or not at all (choose not at all if you plan to upgrade using a SAFE)

---

---

## <a name="upgrade-using-safe"></a>Upgrade using SAFE wallet

- [ ] Make sure you have deployed a new diamond contract (see above)
- [ ] Make sure the diamond contract is owned by the SAFE wallet your will use for the upgrade
- [ ] Make sure the facet you wish to upgrade is deployed but not added to the diamond yet
- [ ] Run this script `./scripts/scriptMaster.sh`, select `11) Propose upgrade TX to Gnosis SAFE`
- [ ] Choose the network you want to run the upgrade on
- [ ] Choose the diamond version `Mutable` or `Immutable`
- [ ] Choose the facet(s) you want to upgrade (you can select multiple using the spacebar)
- [ ] Hit enter and select the SAFE wallet you want to use
- [ ] Hit enter again and wait for the script to finish
- [ ] Go to the Gnosis SAFE app and confirm the transaction
