// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

interface IL1StandardBridge {
    /// @notice Deposit an amount of ETH to a recipient's balance on L2.
    /// @param _to L2 address to credit the withdrawal to.
    /// @param _l2Gas Gas limit required to complete the deposit on L2.
    /// @param _data Optional data to forward to L2. This data is provided
    ///        solely as a convenience for external contracts. Aside from enforcing a maximum
    ///        length, these contracts provide no guarantees about its content.
    function depositETHTo(
        address _to,
        uint32 _l2Gas,
        bytes calldata _data
    ) external payable;

    /// @notice Deposit an amount of the ERC20 to the caller's balance on L2.
    /// @param _l1Token Address of the L1 ERC20 we are depositing
    /// @param _l2Token Address of the L1 respective L2 ERC20
    /// @param _to L2 address to credit the withdrawal to.
    /// @param _amount Amount of the ERC20 to deposit
    /// @param _l2Gas Gas limit required to complete the deposit on L2.
    /// @param _data Optional data to forward to L2. This data is provided
    ///        solely as a convenience for external contracts. Aside from enforcing a maximum
    ///        length, these contracts provide no guarantees about its content.
    function depositERC20To(
        address _l1Token,
        address _l2Token,
        address _to,
        uint256 _amount,
        uint32 _l2Gas,
        bytes calldata _data
    ) external;

    /// @notice Deposit an amount of the ERC20 to the caller's balance on L2.
    /// @dev This function is implemented on SynthetixBridgeToOptimism contract.
    /// @param _to L2 address to credit the withdrawal to.
    /// @param _amount Amount of the ERC20 to deposit
    function depositTo(address _to, uint256 _amount) external;
}
