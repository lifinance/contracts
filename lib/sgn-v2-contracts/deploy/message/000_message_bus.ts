import * as dotenv from 'dotenv';
import { AbiCoder } from 'ethers/lib/utils';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { MessageBus__factory } from '../../typechain/factories/MessageBus__factory';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const initArgs: [string, string, string, string, string] = [
    process.env.MESSAGE_BUS_LIQUIDITY_BRIDGE as string,
    process.env.MESSAGE_BUS_PEG_BRIDGE as string,
    process.env.MESSAGE_BUS_PEG_VAULT as string,
    process.env.MESSAGE_BUS_PEG_BRIDGE_V2 as string,
    process.env.MESSAGE_BUS_PEG_VAULT_V2 as string
  ];
  const constructorArgs = [process.env.MESSAGE_BUS_SIGS_VERIFIER].concat(initArgs);

  await deploy('MessageBus', {
    from: deployer,
    log: true,
    args: constructorArgs,
    proxy: {
      proxyContract: 'OptimizedTransparentProxy',
      execute: {
        // only called when proxy is deployed, it'll call MessageBus contract.init
        // with proper args
        init: {
          methodName: 'init',
          args: initArgs
        }
      }
    }
  });
  const messageBusInterface = MessageBus__factory.createInterface();
  const encodedInitData = messageBusInterface.encodeFunctionData('init', initArgs);
  console.log('Encoded init data', encodedInitData);
  const proxyAdmin = await deployments.get('DefaultProxyAdmin');
  console.log('DefaultProxyAdmin', proxyAdmin.address);
  const proxy = await deployments.get('MessageBus_Proxy');
  console.log('MessageBus_Proxy', proxy.address);
  const messageBus = await deployments.get('MessageBus_Implementation');
  await hre.run('verify:verify', { address: messageBus.address, constructorArguments: constructorArgs });
  // Have to manually verify because hardhat-deploy compiles proxy with 0.8.10
  // const proxyArgs = [messageBus.address, proxyAdmin.address].concat(encodedInitData);
  // await hre.run('verify:verify', { address: proxy.address, constructorArguments: proxyArgs });
  console.log(
    'Encoded proxy constructor args',
    new AbiCoder().encode(['address', 'address', 'bytes'], [messageBus.address, proxyAdmin.address, encodedInitData])
  );
};

deployFunc.tags = ['MessageBus'];
deployFunc.dependencies = [];
export default deployFunc;
