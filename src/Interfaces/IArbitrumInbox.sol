// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

interface IArbitrumInbox {
    /**
     * @notice Deposit eth from L1 to L2 to address of the sender if sender is an EOA, and to its aliased address if the sender is a contract
     * @dev This does not trigger the fallback function when receiving in the L2 side.
     *      Look into retryable tickets if you are interested in this functionality.
     * @dev This function should not be called inside contract constructors
     */
    function depositEth() external payable returns (uint256);
}
