// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";

contract DeployLiFiDiamond2 is DeployScript {
    using stdJson for string;

    function _contractName() internal pure override returns (string memory) {
        return "LiFiDiamond";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(LiFiDiamond).creationCode;
    }

    function _getConstructorArgs(
        string calldata _network,
        string memory _fileSuffix,
        address _deployerAddress
    ) internal override returns (bytes memory) {
        string memory path = string.concat(
            root,
            "/deployments/",
            _network,
            ".",
            _fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);

        address diamondCut = json.readAddress(".DiamondCutFacet");

        return abi.encode(_deployerAddress, diamondCut);
    }
}
