// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title Interface for DiamondCutFacet
/// @author LI.FI (https://li.fi)
/// @custom:version 2.0.0
interface IDiamondCut {
    /// @notice Add/replace/remove any number of functions and optionally execute
    ///         a function with delegatecall
    /// @param _diamondCut Contains the facet addresses and function selectors
    /// @param _init The address of the contract or facet to execute _calldata
    /// @param _calldata A function call, including function selector and arguments
    ///                  _calldata is executed with delegatecall on _init
    function diamondCut(
        LibDiamond.FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external;

    event DiamondCut(
        LibDiamond.FacetCut[] _diamondCut,
        address _init,
        bytes _calldata
    );
}
