// SPDX-License-Identifier: MIT
/// @custom:version 2.0.0
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";

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
