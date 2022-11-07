import * as dotenv from 'dotenv';
import { DeployFunction } from 'hardhat-deploy/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

dotenv.config();

const deployFunc: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
    const { deployments, getNamedAccounts } = hre;
    const { deploy } = deployments;
    const { deployer } = await getNamedAccounts();

    await deploy('RFQ', {
        from: deployer,
        log: true,
        args: [process.env.MESSAGE_BUS_ADDR]
    });
};

deployFunc.tags = ['RFQ'];
deployFunc.dependencies = [];
export default deployFunc;
