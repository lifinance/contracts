// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { InvalidCallData } from "../Errors/GenericErrors.sol";
import { IAttester } from "../Interfaces/IAttester.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";

import { LibAttestableSelectors } from "../Libraries/LibAttestableSelectors.sol";
import { LibPeripheryRegistry } from "../Libraries/LibPeripheryRegistry.sol";

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
    string internal constant BRIDGE_ATTESTER_KEY = "BridgeAttester";

    /// Errors ///

    error SelectorNotAttestable();
    error AttesterNotRegistered();

    /// External Methods ///

    /// @notice Executes `_facetCalldata` on its Diamond facet, then calls `IAttester.attest` on the
    ///         registered attester with this call's arguments; the second argument, `_attesterData`,
    ///         is forwarded unread
    /// @dev The dispatched call's return data is discarded
    /// @param _facetCalldata The bridge facet call, selector included
    /// @param _attesterData The attester's data, forwarded unread
    function startBridgeAttested(
        bytes calldata _facetCalldata,
        // solhint-disable-next-line no-unused-vars
        bytes calldata _attesterData
    ) external payable {
        if (_facetCalldata.length < 4) revert InvalidCallData();
        bytes4 selector = bytes4(_facetCalldata);
        if (!LibAttestableSelectors.isAttestable(selector))
            revert SelectorNotAttestable();
        address facet = LibDiamond
            .diamondStorage()
            .selectorToFacetAndPosition[selector]
            .facetAddress;
        if (facet == address(0)) revert LibDiamond.FunctionDoesNotExist();
        address attester = LibPeripheryRegistry.get(BRIDGE_ATTESTER_KEY);
        if (attester.code.length == 0) revert AttesterNotRegistered();

        bytes4 attestSelector = IAttester.attest.selector;
        // One calldata copy serves both calls: `attest(bytes,bytes)` shares this function's argument
        // encoding, so the attester receives the same bytes with only the selector swapped.
        // solhint-disable-next-line no-inline-assembly
        assembly ("memory-safe") {
            let m := mload(0x40)
            let size := calldatasize()
            calldatacopy(m, 0, size)
            if iszero(
                delegatecall(
                    gas(),
                    facet,
                    add(m, _facetCalldata.offset),
                    _facetCalldata.length,
                    0,
                    0
                )
            ) {
                returndatacopy(m, 0, returndatasize())
                revert(m, returndatasize())
            }
            // Bytes 4..31 are the offset's high bytes: zero, as offset < calldatasize < 2^32.
            mstore(m, attestSelector)
            if iszero(call(gas(), attester, 0, m, size, 0, 0)) {
                returndatacopy(m, 0, returndatasize())
                revert(m, returndatasize())
            }
        }
    }

    /// @notice Enables or disables a bridge-entry selector for `startBridgeAttested`; Diamond owner only
    /// @dev Enable only entrypoints guarded by `nonReentrant`: the gateway has no guard of its own
    /// @param _selector The bridge-entry selector
    /// @param _enabled Whether the gateway may dispatch it
    function setAttestableSelector(bytes4 _selector, bool _enabled) external {
        LibAttestableSelectors.set(_selector, _enabled);
    }

    /// @notice Returns whether `startBridgeAttested` may dispatch `_selector`
    /// @param _selector The bridge-entry selector
    /// @return Whether the selector is enabled
    function isAttestableSelector(
        bytes4 _selector
    ) external view returns (bool) {
        return LibAttestableSelectors.isAttestable(_selector);
    }
}
