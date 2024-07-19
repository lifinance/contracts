// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { CannotAuthoriseSelf, UnAuthorized } from "../Errors/GenericErrors.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

/// @title EmergencyPauseFacet
/// @author LI.FI (https://li.fi)
/// @notice Allows a LI.FI-owned and -controlled, non-multisig "PauserWallet" to remove a facet in case of emergency
/// @custom:version 1.0.0
contract EmergencyPauseFacet {
    /// Events ///
    event EmergencyFacetRemoved(address msgSender);

    /// Storage ///
    address public immutable pauserWallet;

    /// Modifiers ///
    modifier OnlyPauserWalletOrOwner(address msgSender) {
        if (
            msgSender != pauserWallet &&
            msgSender != LibDiamond.contractOwner()
        ) revert UnAuthorized();
        _;
    }

    /// Constructor ///
    /// @param _pauserWallet The address of the wallet that can execute emergency facet removal actions
    constructor(address _pauserWallet) {
        pauserWallet = _pauserWallet;
    }

    /// External Methods ///

    /// @notice Removes the given facet from the diamond
    /// @param _facetAddress The address of the facet to be removed
    /// @param _functionSelectors The list of function selectors associated with this facet
    function removeFacet(
        address _facetAddress,
        bytes4[] calldata _functionSelectors
    ) external OnlyPauserWalletOrOwner(msg.sender) {
        // prepare arguments for diamondCut
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = (
            IDiamondCut.FacetCut({
                facetAddress: _facetAddress,
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: _functionSelectors
            })
        );

        // remove facet
        DiamondCutFacet(address(this)).diamondCut(cut, address(0), "");

        emit EmergencyFacetRemoved(msg.sender);
    }
}
