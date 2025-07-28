// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
// solhint-disable-next-line no-unused-import
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { console2 } from "forge-std/console2.sol";

/// @title LDA Diamond
/// @author LI.FI (https://li.fi)
/// @notice EIP-2535 Diamond Proxy Contract for LiFi DEX Aggregator using selector-based dispatch.
/// @custom:version 2.0.0
contract LdaDiamond {
    constructor(address _contractOwner, address _diamondCutFacet) payable {
        LibDiamond.setContractOwner(_contractOwner);

        // Add the diamondCut external function from the diamondCutFacet
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = IDiamondCut.diamondCut.selector;
        cut[0] = LibDiamond.FacetCut({
            facetAddress: _diamondCutFacet,
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });
        LibDiamond.diamondCut(cut, address(0), "");
    }

    // Find facet for function that is called and execute the
    // function if a facet is found and return any value.
    // solhint-disable-next-line no-complex-fallback
fallback() external payable {
    LibDiamond.DiamondStorage storage ds;
    bytes32 position = LibDiamond.DIAMOND_STORAGE_POSITION;

    // get diamond storage
    assembly {
        ds.slot := position
    }

    // get facet from function selector
    address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;

    if (facet == address(0)) {
        revert LibDiamond.FunctionDoesNotExist();
    }

    // Execute external function from facet using delegatecall and return any value.
    assembly {
        // Forward all calldata to the facet
        calldatacopy(0, 0, calldatasize())

        // Perform the delegatecall
        let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)

        // Copy the returned data
        returndatacopy(0, 0, returndatasize())

        // Bubble up the result using the correct opcode
        switch result
        case 0 {
            // Revert with the data if the call failed
            revert(0, returndatasize())
        }
        default {
            // Return the data if the call succeeded
            return(0, returndatasize())
        }
    }
}

    // Able to receive ether
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}