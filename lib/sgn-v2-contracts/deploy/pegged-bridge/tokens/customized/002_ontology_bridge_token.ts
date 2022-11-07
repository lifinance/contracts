import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  await deploy('OntologyBridgeToken', {
    from: deployer,
    log: true,
    args: [
      process.env.ONTOLOGY_BRIDGE_TOKEN_NAME,
      process.env.ONTOLOGY_BRIDGE_TOKEN_SYMBOL,
      process.env.ONTOLOGY_BRIDGE_TOKEN_BRIDGE,
      process.env.ONTOLOGY_BRIDGE_TOKEN_WRAPPER,
      process.env.ONTOLOGY_BRIDGE_TOKEN_CANONICAL
    ]
  });
};

deployFunc.tags = ['OntologyBridgeToken'];
deployFunc.dependencies = [];
export default deployFunc;
