# Contract Deployment Checklist

The following content will guide you through deploying and configuring all smart contracts to a new network (or to deploy a new staging environment).

If you only want to deploy a new diamond contract and use existing deployed facets, please skip to [this section](#deploy-new)

## Prerequisites

1. Prepare your .env file to have the following values set:

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

## Network Configuration

1. **CREATE3Factory**

   - Each network has its own CREATE3Factory deployment
   - Factory addresses are stored in `networks.json`
   - The factory is automatically deployed if not present on the target network

2. **RPC Configuration**

   - For LI.FI developers: RPC URLs are stored in MongoDB and automatically synced to `.env`
   - For external developers: You must manually set RPC URLs in your `.env` file:
     ```
     ETH_NODE_URI_<NETWORKNAME>="<RPC_URL>"
     ```
     Example:
     ```
     ETH_NODE_URI_MAINNET="https://eth-mainnet.g.alchemy.com/v2/your-api-key"
     ETH_NODE_URI_POLYGON="https://polygon-mainnet.g.alchemy.com/v2/your-api-key"
     ```
   - See `.env.example` for the required format
   - Make sure to use reliable RPC providers for production deployments

3. **Network Verification**
   - Etherscan API keys are required for contract verification
   - Keys are stored in `foundry.toml`
   - Each network needs its own API key

Scripts:

- /scripts/scriptMaster.sh (for deploying any of our contracts)
  - execute with command `./scripts/scriptMaster.sh` in your console

## <a name="deploy-new"></a>Deploy a new diamond and add already deployed facets

(find detailed instructions for each step above)

- [ ] Run this script `./scripts/scriptMaster.sh` and select `3) Deploy all contracts to one selected network (=new network)`
- [ ] Choose a network
- [ ] The script will:
  1. Deploy CREATE3Factory if not present
  2. Store the factory address in networks.json
  3. Deploy the diamond contract
  4. Add all required facets

## <a name="deploying-contracts"></a>Deploying contracts

- [ ] Run the script `./scripts/scriptMaster.sh` and select `1) Deploy one specific contract to one network`
- [ ] Choose the network
- [ ] Choose the contract you want to deploy and choose to add it to the diamond or not (choose not if you plan to upgrade using a SAFE)

## <a name="upgrade-using-safe"></a>Upgrade using SAFE wallet

- [ ] Make sure you have deployed a new diamond contract (see above)
- [ ] Make sure the diamond contract is owned by the SAFE wallet you will use for the upgrade
- [ ] Ensure that you have granted access to a secondary wallet to add dexs/sigs
- [ ] Make sure the facet you wish to upgrade is deployed but not added to the diamond yet
- [ ] Run this script `./scripts/scriptMaster.sh`, select `11) Propose upgrade TX to Gnosis SAFE`
- [ ] Choose the network you want to run the upgrade on
- [ ] Choose the facet(s) you want to upgrade (you can select multiple using the spacebar)
- [ ] Hit enter and select the SAFE wallet you want to use
- [ ] Hit enter again and wait for the script to finish
- [ ] Go to the Gnosis SAFE app and confirm the transaction
