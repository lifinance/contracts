// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("HopFacetOptimized");
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawApprovals = json.parseRaw(
            string.concat(".", network, ".approvals")
        );
        Approval[] memory approvals = abi.decode(rawApprovals, (Approval[]));

        address[] memory contractAddresses = new address[](approvals.length);
        address[] memory tokenAddresses = new address[](approvals.length);

        // Loop through all items and split them in arrays
        for (uint256 i = 0; i < approvals.length; i++) {
            contractAddresses[i] = approvals[i].bContractAddress;
            tokenAddresses[i] = approvals[i].aTokenAddress;
        }

        bytes memory callData = abi.encodeWithSelector(
            HopFacetOptimized.setApprovalForBridges.selector,
            contractAddresses,
            tokenAddresses
        );

        return callData;
    }
}
