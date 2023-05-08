// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { Executor } from "lifi/Periphery/Executor.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("Executor") {}

    function run()
        public
        returns (Executor deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);
        address erc20Proxy = json.readAddress(".ERC20Proxy");

        constructorArgs = abi.encode(deployerAddress, erc20Proxy);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (Executor(payable(address(predicted))), constructorArgs);
        }

        deployed = Executor(
            payable(
                address(
                    factory.deploy(
                        salt,
                        bytes.concat(
                            type(Executor).creationCode,
                            constructorArgs
                        )
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
