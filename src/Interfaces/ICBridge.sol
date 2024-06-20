// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface ICBridge {
    /// @notice Send a cross-chain transfer via the liquidity pool-based bridge.
    /// @dev This function DOES NOT SUPPORT fee-on-transfer / rebasing tokens.
    /// @param _receiver The address of the receiver.
    /// @param _token The address of the token.
    /// @param _amount The amount of the transfer.
    /// @param _dstChainId The destination chain ID.
    /// @param _nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
    /// @param _maxSlippage The max slippage accepted, given as percentage in point (pip).
    ///                     Eg. 5000 means 0.5%. Must be greater than minimalMaxSlippage.
    ///                     Receiver is guaranteed to receive at least (100% - max slippage percentage) * amount
    ///                     or the transfer can be refunded.
    function send(
        address _receiver,
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage
    ) external;

    /// @notice Send a cross-chain transfer via the liquidity pool-based bridge using the native token.
    /// @param _receiver The address of the receiver.
    /// @param _amount The amount of the transfer.
    /// @param _dstChainId The destination chain ID.
    /// @param _nonce A unique number. Can be timestamp in practice.
    /// @param _maxSlippage The max slippage accepted, given as percentage in point (pip).
    ///                     Eg. 5000 means 0.5%. Must be greater than minimalMaxSlippage.
    ///                     Receiver is guaranteed to receive at least (100% - max slippage percentage) * amount
    ///                     or the transfer can be refunded.
    function sendNative(
        address _receiver,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage
    ) external payable;
}
