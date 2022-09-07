// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.13;

interface IGatewayRouter {
    /// @notice Transfer non-native assets
    /// @param _token L1 address of ERC20
    /// @param _to Account to be credited with the tokens in the L2 (can be the user's L2 account or a contract)
    /// @param _amount Token Amount
    /// @param _maxGas Max gas deducted from user's L2 balance to cover L2 execution
    /// @param _gasPriceBid Gas price for L2 execution
    /// @param _data Encoded data from router and user
    function outboundTransfer(
        address _token,
        address _to,
        uint256 _amount,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes calldata _data
    ) external payable returns (bytes memory);

    /// @notice Will be deprecated post-nitro in favour of unsafeCreateRetryableTicket
    ///         Put a message in the L2 inbox that can be reexecuted for some fixed amount of time if it reverts
    /// @dev Advanced usage only (does not rewrite aliases for excessFeeRefundAddress and callValueRefundAddress). createRetryableTicket method is the recommended standard.
    /// @param _destAddr destination L2 contract address
    /// @param _l2CallValue call value for retryable L2 message
    /// @param _maxSubmissionCost Max gas deducted from user's L2 balance to cover base submission fee
    /// @param _excessFeeRefundAddress maxgas x gasprice - execution cost gets credited here on L2 balance
    /// @param _callValueRefundAddress l2Callvalue gets credited here on L2 if retryable txn times out or gets cancelled
    /// @param _maxGas Max gas deducted from user's L2 balance to cover L2 execution
    /// @param _gasPriceBid price bid for L2 execution
    /// @param _data ABI encoded data of L2 message
    /// @return unique id for retryable transaction (keccak256(requestID, uint(0) )
    function createRetryableTicketNoRefundAliasRewrite(
        address _destAddr,
        uint256 _l2CallValue,
        uint256 _maxSubmissionCost,
        address _excessFeeRefundAddress,
        address _callValueRefundAddress,
        uint256 _maxGas,
        uint256 _gasPriceBid,
        bytes calldata _data
    ) external payable returns (uint256);

    /// @notice Returns receiving token address on L2
    /// @param _token Sending token address on L1
    /// @return Receiving token address on L2
    function calculateL2TokenAddress(address _token) external view returns (address);

    /// @notice Returns exact gateway router address for token
    /// @param _token Sending token address on L1
    /// @return Gateway router address for sending token
    function getGateway(address _token) external view returns (address);
}
