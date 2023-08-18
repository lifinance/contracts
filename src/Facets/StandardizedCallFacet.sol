// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title StandardizedCallFacet Facet
/// @author LIFI https://li.finance ed@li.finance
/// @notice Allows calling different facet methods through a single standardized entrypoint
/// @custom:version 1.0.0
contract StandardizedCallFacet {
    /// External Methods ///

    // @notice Make a standardized call to a facet
    // @param calldata The calldata to forward to the facet
    function standardizedCall(bytes calldata callData) external payable {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facetAddress = ds
            .selectorToFacetAndPosition[bytes4(callData[:4])]
            .facetAddress;
        (bool success, ) = facetAddress.delegatecall(callData);
        require(success, "Standardized Call: failed");
    }
}
