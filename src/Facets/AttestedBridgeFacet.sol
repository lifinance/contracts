// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { InvalidCallData } from "../Errors/GenericErrors.sol";
import { IAttester } from "../Interfaces/IAttester.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title AttestedBridgeFacet
/// @author LI.FI (https://li.fi)
/// @notice Delegatecalls an attestable bridge-entry selector, then reports the exact call bytes
///         to the attester registered under `BridgeAttester` in the periphery registry
/// @dev No `nonReentrant`: the dispatched facet holds the Diamond's shared guard.
///      This contract is not intended to custody funds; value and tokens move only inside the
///      dispatched facet, as on a direct call.
/// @custom:version 1.0.0
contract AttestedBridgeFacet {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.attested_bridge");
    string internal constant BRIDGE_ATTESTER_KEY = "BridgeAttester";
    /// @dev `PeripheryRegistryFacet.NAMESPACE`, read here and written only by that facet
    bytes32 internal constant PERIPHERY_REGISTRY_NAMESPACE =
        keccak256("com.lifi.facets.periphery_registry");

    /// Types ///

    struct Storage {
        mapping(bytes4 => bool) attestable;
    }

    /// @dev Must match `PeripheryRegistryFacet.Storage`
    struct PeripheryRegistryStorage {
        mapping(string => address) contracts;
    }

    /// Events ///

    event AttestableSelectorSet(bytes4 indexed selector, bool enabled);

    /// Errors ///

    error SelectorNotAttestable();
    error AttesterNotRegistered();
    error GatewaySelectorNotAttestable();

    /// External Methods ///

    /// @notice Executes `_facetCalldata` on its Diamond facet, then calls `IAttester.attest` on the
    ///         registered attester with this call's arguments
    /// @dev The dispatched call's return data is discarded
    /// @param _facetCalldata The bridge facet call, selector included
    /// @param _attesterData Opaque data for the attester; the facet never reads it
    function startBridgeAttested(
        bytes calldata _facetCalldata,
        bytes calldata _attesterData
    ) external payable {
        if (_facetCalldata.length < 4) revert InvalidCallData();
        bytes4 selector = bytes4(_facetCalldata);
        if (!getStorage().attestable[selector]) revert SelectorNotAttestable();
        address facet = LibDiamond
            .diamondStorage()
            .selectorToFacetAndPosition[selector]
            .facetAddress;
        if (facet == address(0)) revert LibDiamond.FunctionDoesNotExist();
        address attester = getPeripheryRegistryStorage().contracts[
            BRIDGE_ATTESTER_KEY
        ];
        if (attester.code.length == 0) revert AttesterNotRegistered();

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = facet.delegatecall(
            _facetCalldata
        );
        if (!success) LibUtil.revertWith(result);

        IAttester(attester).attest(_facetCalldata, _attesterData);
    }

    /// @notice Enables or disables a bridge-entry selector for `startBridgeAttested`; Diamond
    ///         owner only
    /// @dev Enable only entrypoints guarded by `nonReentrant`: the gateway has no guard of its own
    /// @param _selector The bridge-entry selector
    /// @param _enabled Whether the gateway may dispatch it
    function setAttestableSelector(bytes4 _selector, bool _enabled) external {
        LibDiamond.enforceIsContractOwner();
        if (
            _selector == this.startBridgeAttested.selector ||
            _selector == this.setAttestableSelector.selector ||
            _selector == this.isAttestableSelector.selector
        ) revert GatewaySelectorNotAttestable();

        getStorage().attestable[_selector] = _enabled;

        emit AttestableSelectorSet(_selector, _enabled);
    }

    /// @notice Returns whether `startBridgeAttested` may dispatch `_selector`
    /// @param _selector The bridge-entry selector
    /// @return Whether the selector is enabled
    function isAttestableSelector(
        bytes4 _selector
    ) external view returns (bool) {
        return getStorage().attestable[_selector];
    }

    /// Private Methods ///

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }

    /// @dev fetch the periphery registry's storage
    function getPeripheryRegistryStorage()
        private
        pure
        returns (PeripheryRegistryStorage storage s)
    {
        bytes32 namespace = PERIPHERY_REGISTRY_NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
