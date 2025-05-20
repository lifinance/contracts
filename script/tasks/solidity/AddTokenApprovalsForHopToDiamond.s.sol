// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    address[] internal contractAddresses;
    address[] internal tokenAddresses;

    function run() public returns (address[] memory facets) {
        // load config
        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawApprovals = json.parseRaw(
            string.concat(".", network, ".approvals")
        );
        Approval[] memory approvals = abi.decode(rawApprovals, (Approval[]));

        // Loop through all items and split them in arrays
        for (uint256 i = 0; i < approvals.length; i++) {
            contractAddresses.push(approvals[i].bContractAddress);
            tokenAddresses.push(approvals[i].aTokenAddress);
        }

        vm.startBroadcast(deployerPrivateKey);

        // Update via Diamond
        HopFacetOptimized(diamond).setApprovalForBridges(
            contractAddresses,
            tokenAddresses
        );

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
