// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

interface IWormholeRouter {
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external;
}
