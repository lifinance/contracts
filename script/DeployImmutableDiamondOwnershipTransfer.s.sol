// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, console } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ImmutableDiamondOwnershipTransfer } from "lifi/Helpers/ImmutableDiamondOwnershipTransfer.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ImmutableDiamondOwnershipTransfer") {}

    function run()
    public
    returns (ImmutableDiamondOwnershipTransfer deployed, bytes memory constructorArgs)
    {
        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (ImmutableDiamondOwnershipTransfer(payable(predicted)), constructorArgs);
        }

        deployed = ImmutableDiamondOwnershipTransfer(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(type(ImmutableDiamondOwnershipTransfer).creationCode, constructorArgs)
                )
            )
        );

        vm.stopBroadcast();
    }
}
