// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { CannotAuthoriseSelf, UnAuthorized, InvalidCallData, DiamondIsPaused } from "../Errors/GenericErrors.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

/// @title EmergencyPauseFacet (Admin only)
/// @author LI.FI (https://li.fi)
/// @notice Allows a LI.FI-owned and -controlled, non-multisig "PauserWallet" to remove a facet or pause the diamond in case of emergency
/// @custom:version 1.0.0
/// @dev Admin-Facet for emergency purposes only
contract EmergencyPauseFacet {
    /// Events ///
    event EmergencyFacetRemoved(address facetAddress, address msgSender);
    event EmergencyPaused(address msgSender);
    event EmergencyUnpaused(address msgSender);

    /// Storage ///
    address public immutable pauserWallet;
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.emergencyPauseFacet");
    address public immutable emergencyPauseFacetAddress;

    struct Storage {
        IDiamondLoupe.Facet[] facets;
    }

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
        emergencyPauseFacetAddress = address(this);
    }

    /// External Methods ///

    /// @notice Removes the given facet from the diamond
    /// @param _facetAddress The address of the facet that should be removed
    /// @dev can only be executed by pauserWallet (non-multisig for fast response time) or by the diamond owner
    function removeFacet(
        address _facetAddress
    ) external OnlyPauserWalletOrOwner(msg.sender) {
        // get function selectors for this facet
        bytes4[] memory functionSelectors = DiamondLoupeFacet(address(this))
            .facetFunctionSelectors(_facetAddress);

        // make sure that DiamondCutFacet cannot be removed
        if (functionSelectors[0] == DiamondCutFacet.diamondCut.selector)
            revert InvalidCallData();

        // prepare arguments for diamondCut
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = (
            IDiamondCut.FacetCut({
                facetAddress: _facetAddress,
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: functionSelectors
            })
        );

        // remove facet
        LibDiamond.removeFunctions(address(0), functionSelectors);

        emit EmergencyFacetRemoved(_facetAddress, msg.sender);
    }

    /// @notice Effectively pauses the diamond contract by overwriting the facetAddress-to-function-selector mappings in storage for all facets
    ///         and redirecting all function selectors to the EmergencyPauseFacet (this will remain as the only registered facet) so that
    ///         a meaningful error message will be returned when third parties try to call the diamond
    /// @dev can only be executed by pauserWallet (non-multisig for fast response time) or by the diamond owner
    function pauseDiamond() external OnlyPauserWalletOrOwner(msg.sender) {
        //TODO: add handling for cases where there are too many facets and tx will run out of gas (>> pagination) ??
        Storage storage s = getStorage();

        // get a list of all facets that need to be removed (=all facets except EmergencyPauseFacet)
        IDiamondLoupe.Facet[]
            memory facets = _getAllFacetFunctionSelectorsToBeRemoved();

        // go through all facets
        for (uint256 i; i < facets.length; ) {
            // remove functions from diamond
            LibDiamond.replaceFunctions(
                emergencyPauseFacetAddress,
                facets[i].functionSelectors
            );

            // write facet to storage (so it can be easily reactivated later on)
            s.facets.push(facets[i]);

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        emit EmergencyPaused(msg.sender);
    }

    /// @notice Unpauses the diamond contract by re-adding all facetAddress-to-function-selector mappings to storage
    /// @dev can only be executed by diamond owner (multisig)
    /// @param _blacklist The address(es) of facet(s) that should not be reactivated
    function unpauseDiamond(address[] calldata _blacklist) external {
        // make sure this function can only be called by the owner
        LibDiamond.enforceIsContractOwner();

        // get all facets from storage
        Storage storage s = getStorage();

        // go through all facets
        for (uint256 i; i < s.facets.length; ) {
            // check if facet address belongs to blacklisted facets
            if (_containsAddress(_blacklist, s.facets[i].facetAddress))
                // skip this iteration (> do not re-add facet)
                continue;

            // re-add facet and its selectors to diamond
            LibDiamond.replaceFunctions(
                s.facets[i].facetAddress,
                s.facets[i].functionSelectors
            );

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        emit EmergencyUnpaused(msg.sender);
    }

    /// INTERNAL HELPER FUNCTIONS

    function _isEmergencyPauseFacet(
        IDiamondLoupe.Facet memory facet
    ) internal pure returns (bool) {
        // iterate through all function selectors and make sure they all match with EmergencyPauseFacet
        for (uint256 i; i < facet.functionSelectors.length; i++) {
            bytes4 currentSelector = facet.functionSelectors[i];
            if (
                currentSelector != EmergencyPauseFacet.removeFacet.selector &&
                currentSelector != EmergencyPauseFacet.pauseDiamond.selector &&
                currentSelector != EmergencyPauseFacet.unpauseDiamond.selector
            ) return false;
        }
        return true;
    }

    function _containsAddress(
        address[] memory _addresses,
        address _find
    ) internal pure returns (bool) {
        // check if facet address belongs to blacklist
        for (uint256 i; i < _addresses.length; ) {
            // if address matches, return true
            if (_addresses[i] == _find) return true;

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }
        return false;
    }

    function _getAllFacetFunctionSelectorsToBeRemoved()
        internal
        view
        returns (IDiamondLoupe.Facet[] memory toBeRemoved)
    {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory allFacets = DiamondLoupeFacet(
            address(this)
        ).facets();

        // initiate return variable with allFacets length - 1 (since we will not use the EmergencyPauseFacet)
        toBeRemoved = new IDiamondLoupe.Facet[](allFacets.length - 1);

        // iterate through facets, copy every facet but EmergencyPauseFacet
        for (uint256 i; i < allFacets.length; i++) {
            // if its not the EmergencyPauseFacet, copy to the return value variable
            if (!_isEmergencyPauseFacet(allFacets[i])) {
                toBeRemoved[i].facetAddress = allFacets[i].facetAddress;
                toBeRemoved[i].functionSelectors = allFacets[i]
                    .functionSelectors;
            }
        }
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }

    // this function will be called when the diamond is paused to return a meaningful error message instead of "FunctionDoesNotExist"
    fallback() external payable {
        revert DiamondIsPaused();
    }

    // only added to silence compiler warnings
    receive() external payable {}
}
