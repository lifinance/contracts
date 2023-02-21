// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, console } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import "./utils/UpdateScriptBase.sol";


contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    constructor() UpdateScriptBase() {
    }

    function run()
        public
        returns (LiFiDiamond deployed, bytes memory constructorArgs)
    {
        address diamondCut = json.readAddress(".DiamondCutFacet");

        vm.startBroadcast(deployerPrivateKey);

        if (!isContract(diamond)) {
            revert("Error in script - check if diamondImmutable is deployed under stored address");
        }

        // remove diamondCut facet to not allow any further code changes to the contract
        bytes4[] memory exclude;
        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: getSelectors("DiamondCutFacet", exclude)
            })
        );
        cutter.diamondCut(cut, address(0), "");

        vm.stopBroadcast();
    }

    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }

}
