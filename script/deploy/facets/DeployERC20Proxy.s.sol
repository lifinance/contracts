// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ERC20Proxy") {}

    function run()
        public
        returns (ERC20Proxy deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ERC20Proxy(deploy(type(ERC20Proxy).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory globalConfigPath = string.concat(
            root,
            "/config/global.json"
        );

        string memory globalConfigJson = vm.readFile(globalConfigPath);

        address refundWalletAddress = globalConfigJson.readAddress(
            ".refundWallet"
        );

        string memory executorDeploySalt = vm.envOr(
            "EXECUTOR_DEPLOYSALT",
            string("")
        );
        address predictedExecutor = address(0);
        if (bytes(executorDeploySalt).length != 0) {
            predictedExecutor = _getPredictedAddressFromDeploySalt(
                executorDeploySalt,
                "Executor"
            );
            emit log_named_address(
                "LI.FI: Predicted Executor Address: ",
                predictedExecutor
            );
        } else {
            emit log(
                "LI.FI: EXECUTOR_DEPLOYSALT unset - skipping Executor pre-authorization"
            );
        }

        return abi.encode(refundWalletAddress, predictedExecutor);
    }
}
