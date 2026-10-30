// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IAttester
/// @notice Receives the exact call bytes `AttestedBridgeFacet` dispatched
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IAttester {
    /// @notice Called after a successful dispatch, with the calldata of `startBridgeAttested`
    /// @param _facetCalldata The bytes the gateway delegatecalled, selector included
    /// @param _attesterData Opaque data for the attester
    function attest(
        bytes calldata _facetCalldata,
        bytes calldata _attesterData
    ) external;
}
