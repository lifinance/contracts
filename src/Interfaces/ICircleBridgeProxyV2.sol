// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for CircleBridgeProxyV2
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ICircleBridgeProxyV2 {
    /// @notice Deposits and burns tokens from sender to be minted on destination domain.
    /// @dev reverts if:
    ///      - given burnToken is not supported.
    ///      - given destinationDomain has no TokenMessenger registered.
    ///      - transferFrom() reverts. For example, if sender's burnToken balance
    ///        or approved allowance to this contract is less than `amount`.
    ///      - burn() reverts. For example, if `amount` is 0.
    ///      - MessageTransmitter returns false or reverts.
    /// @param _amount Amount of tokens to burn.
    /// @param _dstChid Destination domain.
    /// @param _mintRecipient Address of mint recipient on destination domain.
    /// @param _burnToken Address of contract to burn deposited tokens, on local domain.
    /// @param _maxFee Maximum fee to pay on the destination domain, specified in units of burnToken. 0 means no fee limit.
    /// @param _minFinalityThreshold The minimum finality at which a burn message will be attested to. 1000 = fast path, 2000 = standard path.
    function depositForBurn(
        uint256 _amount,
        uint64 _dstChid,
        bytes32 _mintRecipient,
        address _burnToken,
        uint256 _maxFee,
        uint32 _minFinalityThreshold
    ) external;
}
