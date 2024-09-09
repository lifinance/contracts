// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibDiamondLoupe } from "../Libraries/LibDiamondLoupe.sol";
import { UnAuthorized, InvalidCallData, DiamondIsPaused } from "../Errors/GenericErrors.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

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

    /// Errors ///
    error FacetIsNotRegistered();

    /// Storage ///
    address public immutable pauserWallet;
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.emergencyPauseFacet");
    address internal immutable _emergencyPauseFacetAddress;

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
        _emergencyPauseFacetAddress = address(this);
    }

    /// External Methods ///

    /// @notice Removes the given facet from the diamond
    /// @param _facetAddress The address of the facet that should be removed
    /// @dev can only be executed by pauserWallet (non-multisig for fast response time) or by the diamond owner
    function removeFacet(
        address _facetAddress
    ) external OnlyPauserWalletOrOwner(msg.sender) {
        // get function selectors for this facet
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        bytes4[] memory functionSelectors = ds
            .facetFunctionSelectors[_facetAddress]
            .functionSelectors;

        // do not continue if no registered function selectors were found
        if (functionSelectors.length == 0) revert FacetIsNotRegistered();

        // make sure that DiamondCutFacet cannot be removed
        if (functionSelectors[0] == DiamondCutFacet.diamondCut.selector)
            revert InvalidCallData();

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
            // redirect all function selectors to this facet (i.e. to its fallback function with the DiamondIsPaused() error message)
            LibDiamond.replaceFunctions(
                _emergencyPauseFacetAddress,
                facets[i].functionSelectors
            );

            // write facet information to storage (so it can be easily reactivated later on)
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

        // iterate through all facets and reinstate the facet with its function selectors
        for (uint256 i; i < s.facets.length; ) {
            LibDiamond.replaceFunctions(
                s.facets[i].facetAddress,
                s.facets[i].functionSelectors
            );

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        // go through blacklist and overwrite all function selectors with zero address
        // It would be easier to not reinstate these facets in the first place but
        //  a) that would leave their function selectors associated with address of EmergencyPauseFacet (=> throws 'DiamondIsPaused() error when called)
        //  b) it consumes a lot of gas to check every facet address if it's part of the blacklist
        for (uint256 i; i < _blacklist.length; ) {
            // re-add facet and its selectors to diamond
            LibDiamond.removeFunctions(
                address(0),
                LibDiamondLoupe.facetFunctionSelectors(_blacklist[i])
            );

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        // free storage
        delete s.facets;

        emit EmergencyUnpaused(msg.sender);
    }

    /// INTERNAL HELPER FUNCTIONS

    function _isEmergencyPauseFacet(
        IDiamondLoupe.Facet memory facet
    ) internal view returns (bool) {
        if (facet.facetAddress == _emergencyPauseFacetAddress) return true;

        return false;
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
        IDiamondLoupe.Facet[] memory allFacets = LibDiamondLoupe.facets();

        // initiate return variable with allFacets length - 1 (since we will not remove the EmergencyPauseFacet)
        delete toBeRemoved;
        toBeRemoved = new IDiamondLoupe.Facet[](allFacets.length - 1);

        // iterate through facets, copy every facet but EmergencyPauseFacet
        uint256 toBeRemovedCounter;
        for (uint256 i; i < allFacets.length; ) {
            // if its not the EmergencyPauseFacet, copy to the return value variable
            if (!_isEmergencyPauseFacet(allFacets[i])) {
                toBeRemoved[toBeRemovedCounter].facetAddress = allFacets[i]
                    .facetAddress;
                toBeRemoved[toBeRemovedCounter].functionSelectors = allFacets[
                    i
                ].functionSelectors;

                // gas-efficient way to increase counter
                unchecked {
                    ++toBeRemovedCounter;
                }
            }

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
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

    // only added to silence compiler warnings that arose after adding the fallback function
    receive() external payable {}
}
