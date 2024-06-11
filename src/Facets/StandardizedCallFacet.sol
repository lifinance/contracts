// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title Standardized Call Facet
/// @author LIFI https://li.finance ed@li.finance
/// @notice Allows calling different facet methods through a single standardized entrypoint
/// @custom:version 1.1.0
contract StandardizedCallFacet {
    /// External Methods ///

    /// @notice Make a standardized call to a facet
    /// @param callData The calldata to forward to the facet
    function standardizedCall(bytes memory callData) external payable {
        execute(callData);
    }

    /// @notice Make a standardized call to a facet
    /// @param callData The calldata to forward to the facet
    function standardizedSwapCall(bytes memory callData) external payable {
        execute(callData);
    }

    /// @notice Make a standardized call to a facet
    /// @param callData The calldata to forward to the facet
    function standardizedBridgeCall(bytes memory callData) external payable {
        execute(callData);
    }

    /// @notice Make a standardized call to a facet
    /// @param callData The calldata to forward to the facet
    function standardizedSwapAndBridgeCall(
        bytes memory callData
    ) external payable {
        execute(callData);
    }

    function execute(bytes memory callData) internal {
        // Fetch the facetAddress from the dimaond's internal storage
        // Cheaper than calling the external facetAddress(selector) method directly
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facetAddress = ds
            .selectorToFacetAndPosition[bytes4(callData)]
            .facetAddress;

        if (facetAddress == address(0)) {
            revert LibDiamond.FunctionDoesNotExist();
        }

        // Execute external function from facet using delegatecall and return any value.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            // execute function call using the facet
            let result := delegatecall(
                gas(),
                facetAddress,
                add(callData, 0x20),
                mload(callData),
                0,
                0
            )
            // get any return value
            returndatacopy(0, 0, returndatasize())
            // return any return value or error back to the caller
            switch result
            case 0 {
                revert(0, returndatasize())
            }
            default {
                return(0, returndatasize())
            }
        }
    }
}
