// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { IDiamondCut } from "../Interfaces/IDiamondCut.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";

/// @title Diamond Cut Facet
/// @author LI.FI (https://li.fi)
/// @notice Core EIP-2535 Facet for upgrading Diamond Proxies.
/// @custom:version 1.0.0
contract DiamondCutFacet is IDiamondCut {
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
    ) external {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }
}
