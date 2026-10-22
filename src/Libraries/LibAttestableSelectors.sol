// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "./LibDiamond.sol";

/// @title LibAttestableSelectors
/// @author LI.FI (https://li.fi)
/// @notice The bridge-entry selectors `AttestedBridgeFacet.startBridgeAttested` may dispatch
/// @custom:version 1.0.0
library LibAttestableSelectors {
    /// Storage ///
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.library.attestable_selectors");

    /// @dev `AttestedBridgeFacet`'s own selectors, which are never attestable
    bytes4 internal constant START_BRIDGE_ATTESTED =
        bytes4(keccak256("startBridgeAttested(bytes,bytes)"));
    bytes4 internal constant SET_ATTESTABLE_SELECTOR =
        bytes4(keccak256("setAttestableSelector(bytes4,bool)"));
    bytes4 internal constant IS_ATTESTABLE_SELECTOR =
        bytes4(keccak256("isAttestableSelector(bytes4)"));

    /// Types ///

    struct Storage {
        mapping(bytes4 => bool) attestable;
    }

    /// Events ///

    event AttestableSelectorSet(bytes4 indexed selector, bool enabled);

    /// Errors ///

    error GatewaySelectorNotAttestable();

    /// Internal Methods ///

    /// @notice Enables or disables `_selector` for attested dispatch; Diamond owner only
    /// @param _selector The bridge-entry selector
    /// @param _enabled Whether the gateway may dispatch it
    function set(bytes4 _selector, bool _enabled) internal {
        LibDiamond.enforceIsContractOwner();
        if (
            _selector == START_BRIDGE_ATTESTED ||
            _selector == SET_ATTESTABLE_SELECTOR ||
            _selector == IS_ATTESTABLE_SELECTOR
        ) revert GatewaySelectorNotAttestable();

        getStorage().attestable[_selector] = _enabled;

        emit AttestableSelectorSet(_selector, _enabled);
    }

    /// @notice Returns whether `_selector` is enabled for attested dispatch
    /// @param _selector The bridge-entry selector
    /// @return Whether the selector is enabled
    function isAttestable(bytes4 _selector) internal view returns (bool) {
        return getStorage().attestable[_selector];
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
