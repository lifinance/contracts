// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScript } from "./utils/DeployScript.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamondImmutable } from "lifi/LiFiDiamondImmutable.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";

contract DeployLiFiDiamondImmutable2 is DeployScript {
    using stdJson for string;

    IDiamondCut.FacetCut[] internal cut;
    address internal diamondImmutable;
    DiamondCutFacet internal cutter;

    function _contractName() internal pure override returns (string memory) {
        return "LiFiDiamondImmutable";
    }

    function _creationCode() internal pure override returns (bytes memory) {
        return type(LiFiDiamondImmutable).creationCode;
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
