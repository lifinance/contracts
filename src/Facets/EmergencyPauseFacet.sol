// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibDiamondLoupe } from "../Libraries/LibDiamondLoupe.sol";
import { UnAuthorized, InvalidCallData, DiamondIsPaused } from "../Errors/GenericErrors.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";

/// @title EmergencyPauseFacet (Admin only)
/// @author LI.FI (https://li.fi)
/// @notice Allows a LI.FI-owned and -controlled, non-multisig "PauserWallet" to remove a facet or pause the diamond in case of emergency
/// @custom:version 1.0.0
/// @dev Admin-Facet for emergency purposes only
contract EmergencyPauseFacet {
    /// Events ///
    event EmergencyFacetRemoved(
        address indexed facetAddress,
        address indexed msgSender
    );
    event EmergencyPaused(address indexed msgSender);
    event EmergencyUnpaused(address indexed msgSender);

    /// Errors ///
    error FacetIsNotRegistered();
    error NoFacetToPause();

    /// Storage ///
    address public immutable pauserWallet;
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.emergencyPauseFacet");
    address internal immutable _emergencyPauseFacetAddress;

    struct Storage {
        IDiamondLoupe.Facet[] facets;
    }

    /// Modifiers ///
    modifier OnlyPauserWalletOrOwner() {
        if (
            msg.sender != pauserWallet &&
            msg.sender != LibDiamond.contractOwner()
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
    ) external OnlyPauserWalletOrOwner {
        // make sure that the EmergencyPauseFacet itself cannot be removed through this function
        if (_facetAddress == _emergencyPauseFacetAddress)
            revert InvalidCallData();

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
    /// @dev This function could potentially run out of gas if too many facets/function selectors are involved. We mitigate this issue by having a test on
    /// @dev forked mainnet (which has most facets) that checks if the diamond can be paused
    function pauseDiamond() external OnlyPauserWalletOrOwner {
        Storage storage s = getStorage();

        // get a list of all facets that need to be removed (=all facets except EmergencyPauseFacet)
        IDiamondLoupe.Facet[]
            memory facets = _getAllFacetFunctionSelectorsToBeRemoved();

        // prevent invalid contract state
        if (facets.length == 0) revert NoFacetToPause();

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
        bytes4[] memory currentSelectors;
        for (uint256 i; i < _blacklist.length; ) {
            currentSelectors = LibDiamondLoupe.facetFunctionSelectors(
                _blacklist[i]
            );

            // make sure that the DiamondCutFacet cannot be removed as this would make the diamond immutable
            if (currentSelectors[0] == DiamondCutFacet.diamondCut.selector)
                continue;

            // build FacetCut parameter
            IDiamondCut.FacetCut[]
                memory facetCut = new IDiamondCut.FacetCut[](1);
            facetCut[0] = IDiamondCut.FacetCut({
                facetAddress: address(0), // needs to be address(0) for removals
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: currentSelectors
            });

            // remove facet and its selectors from diamond
            LibDiamond.diamondCut(facetCut, address(0), "");

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

    function _getAllFacetFunctionSelectorsToBeRemoved()
        internal
        view
        returns (IDiamondLoupe.Facet[] memory toBeRemoved)
    {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory allFacets = LibDiamondLoupe.facets();

        // initiate return variable with allFacets length - 1 (since we will not remove the EmergencyPauseFacet)
        toBeRemoved = new IDiamondLoupe.Facet[](allFacets.length - 1);

        // iterate through facets, copy every facet but EmergencyPauseFacet
        uint256 toBeRemovedCounter;
        for (uint256 i; i < allFacets.length; ) {
            // if its not the EmergencyPauseFacet, copy to the return value variable
            if (allFacets[i].facetAddress != _emergencyPauseFacetAddress) {
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
