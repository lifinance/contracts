// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface ICircleBridgeProxy {
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
    /// @return nonce Unique nonce reserved by message.
    function depositForBurn(
        uint256 _amount,
        uint64 _dstChid,
        bytes32 _mintRecipient,
        address _burnToken
    ) external returns (uint64 nonce);
}
