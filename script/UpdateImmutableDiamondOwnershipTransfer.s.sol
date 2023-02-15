// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { ImmutableDiamondOwnershipTransfer } from "lifi/Helpers/ImmutableDiamondOwnershipTransfer.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".ImmutableDiamondOwnershipTransfer");

        // prepare calldata to call transferOwnershipToZeroAddress function
        bytes memory callData = abi.encodeWithSelector(
            ImmutableDiamondOwnershipTransfer.transferOwnershipToZeroAddress.selector
        );

        vm.startBroadcast(deployerPrivateKey);

        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude = new bytes4[](1);
            exclude[0] = ImmutableDiamondOwnershipTransfer.transferOwnershipToZeroAddress.selector;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("ImmutableDiamondOwnershipTransfer", exclude)
                })
            );
            cutter.diamondCut(cut, facet, callData);
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
