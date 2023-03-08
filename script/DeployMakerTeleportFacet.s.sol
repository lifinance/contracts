// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { MakerTeleportFacet } from "lifi/Facets/MakerTeleportFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("MakerTeleportFacet") {}

    function run() public returns (MakerTeleportFacet deployed, bytes memory constructorArgs) {
        string memory path = string.concat(vm.projectRoot(), "/config/maker.json");
        string memory json = vm.readFile(path);
        address makerTeleport = json.readAddress(string.concat(".", network, ".makerTeleport"));
        address dai = json.readAddress(string.concat(".", network, ".dai"));
        uint256 dstChainId = json.readUint(string.concat(".", network, ".dstChainId"));
        bytes32 l1Domain = json.readBytes32(string.concat(".", network, ".l1Domain"));

        constructorArgs = abi.encode(makerTeleport, dai, dstChainId, l1Domain);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (MakerTeleportFacet(payable(predicted)), constructorArgs);
        }

        deployed = MakerTeleportFacet(
            payable(factory.deploy(salt, bytes.concat(type(MakerTeleportFacet).creationCode, constructorArgs)))
        );

        vm.stopBroadcast();
    }
}
