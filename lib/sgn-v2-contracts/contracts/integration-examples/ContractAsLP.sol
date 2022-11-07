// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../interfaces/IPool.sol";
import "../interfaces/IWithdrawInbox.sol";
import "../safeguard/Pauser.sol";

/**
 * @title Example contract to provide liquidity to {Bridge}. Supports withdrawing liquidity via {WithdrawInbox}.
 */
contract ContractAsLP is ReentrancyGuard, Pauser {
    using SafeERC20 for IERC20;

    address public bridge;
    address public inbox;

    event Deposited(address depositor, address token, uint256 amount);

    constructor(address _bridge, address _inbox) {
        bridge = _bridge;
        inbox = _inbox;
    }

    /**
     * @notice Deposit tokens.
     * @param _token The deposited token address.
     * @param _amount The amount to deposit.
     */
    function deposit(address _token, uint256 _amount) external nonReentrant whenNotPaused onlyOwner {
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        emit Deposited(msg.sender, _token, _amount);
    }

    /**
     * @notice Add liquidity to the pool-based bridge.
     * NOTE: This function DOES NOT SUPPORT fee-on-transfer / rebasing tokens.
     * @param _token The address of the token.
     * @param _amount The amount to add.
     */
    function addLiquidity(address _token, uint256 _amount) external whenNotPaused onlyOwner {
        require(IERC20(_token).balanceOf(address(this)) >= _amount, "insufficient balance");
        IERC20(_token).safeIncreaseAllowance(bridge, _amount);
        IPool(bridge).addLiquidity(_token, _amount);
    }

    /**
     * @notice Withdraw liquidity from the pool-based bridge.
     * NOTE: Each of your withdrawal request should have different _wdSeq.
     * NOTE: Tokens to withdraw within one withdrawal request should have the same symbol.
     * @param _wdSeq The unique sequence number to identify this withdrawal request.
     * @param _receiver The receiver address on _toChain.
     * @param _toChain The chain Id to receive the withdrawn tokens.
     * @param _fromChains The chain Ids to withdraw tokens.
     * @param _tokens The token to withdraw on each fromChain.
     * @param _ratios The withdrawal ratios of each token.
     * @param _slippages The max slippages of each token for cross-chain withdraw.
     */
    function withdraw(
        uint64 _wdSeq,
        address _receiver,
        uint64 _toChain,
        uint64[] calldata _fromChains,
        address[] calldata _tokens,
        uint32[] calldata _ratios,
        uint32[] calldata _slippages
    ) external whenNotPaused onlyOwner {
        IWithdrawInbox(inbox).withdraw(_wdSeq, _receiver, _toChain, _fromChains, _tokens, _ratios, _slippages);
    }
}
