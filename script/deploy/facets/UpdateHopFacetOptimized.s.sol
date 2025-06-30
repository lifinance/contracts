// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    error InvalidBridgeContractAddress(address);
    error InvalidContractAddress(address);

    struct HopApproval {
        address tokenAddress;
        address bridgeContractAddress;
        string tokenName;
        string contractName;
    }

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
        HopApproval[] memory approvals = abi.decode(
            rawApprovals,
            (HopApproval[])
        );

        address[] memory contractAddresses = new address[](approvals.length);
        address[] memory tokenAddresses = new address[](approvals.length);

        // Loop through all items and split them in arrays
        for (uint256 i = 0; i < approvals.length; i++) {
            if (!LibAsset.isContract(approvals[i].bridgeContractAddress))
                revert InvalidBridgeContractAddress(
                    approvals[i].bridgeContractAddress
                );
            contractAddresses[i] = approvals[i].bridgeContractAddress;

            if (!LibAsset.isContract(approvals[i].tokenAddress))
                revert InvalidContractAddress(approvals[i].tokenAddress);
            tokenAddresses[i] = approvals[i].tokenAddress;
        }

        bytes memory callData = abi.encodeWithSelector(
            HopFacetOptimized.setApprovalForBridges.selector,
            contractAddresses,
            tokenAddresses
        );

        return callData;
    }
}
