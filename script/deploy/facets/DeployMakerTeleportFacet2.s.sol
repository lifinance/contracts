// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { MakerTeleportFacet } from "lifi/Facets/MakerTeleportFacet.sol";

contract DeployMakerTeleportFacet2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "MakerTeleportFacet";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(MakerTeleportFacet).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory,
        address
    ) internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/maker.json");
        string memory json = vm.readFile(path);

        address makerTeleport = json.readAddress(
            string.concat(".", _network, ".makerTeleport")
        );
        address dai = json.readAddress(string.concat(".", _network, ".dai"));
        uint256 dstChainId = json.readUint(
            string.concat(".", _network, ".dstChainId")
        );
        bytes32 l1Domain = json.readBytes32(
            string.concat(".", _network, ".l1Domain")
        );

        return abi.encode(makerTeleport, dai, dstChainId, l1Domain);
    }
}
