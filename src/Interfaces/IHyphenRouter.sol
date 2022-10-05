// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// https://github.com/bcnmy/hyphen-contract/blob/master/contracts/hyphen/LiquidityPool.sol
interface IHyphenRouter {
    function depositErc20(
        uint256 toChainId,
        address tokenAddress,
        address receiver,
        uint256 amount,
        string calldata tag
    ) external;

    function depositNative(
        address receiver,
        uint256 toChainId,
        string calldata tag
    ) external payable;
}
