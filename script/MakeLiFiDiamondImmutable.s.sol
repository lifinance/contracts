// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, console } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import "./utils/UpdateScriptBase.sol";

contract ImmutableDiamondOwnershipTransfer {

    /// @notice Transfers ownership of diamond to address(0) (for immutable diamond)
    function transferOwnershipToZeroAddress() external  {
        // transfer ownership to 0 address
        LibDiamond.setContractOwner(address(0));
    }
}

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    ImmutableDiamondOwnershipTransfer internal ownershipTransfer;

    constructor() UpdateScriptBase() {
        ownershipTransfer = new ImmutableDiamondOwnershipTransfer();
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

        // prepare calldata to call transferOwnershipToZeroAddress function (during diamondCut)
        bytes memory callData = abi.encodeWithSelector(
            ImmutableDiamondOwnershipTransfer.transferOwnershipToZeroAddress.selector
        );

        // remove diamondCut facet to not allow any further code changes to the contract
        bytes4[] memory exclude;
        cut.push(
            IDiamondCut.FacetCut({
                facetAddress: address(0),
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: getSelectors("DiamondCutFacet", exclude)
            })
        );

        // remove cutFacet and transferOwnership to address(0)
        cutter.diamondCut(cut, address(ownershipTransfer), callData);

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
