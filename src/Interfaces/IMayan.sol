// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMayan {
    struct RelayerFees {
        uint64 swapFee;
        uint64 redeemFee;
        uint64 refundFee;
    }

    struct Recepient {
        bytes32 mayanAddr;
        uint16 mayanChainId;
        bytes32 auctionAddr;
        bytes32 destAddr;
        uint16 destChainId;
        bytes32 referrer;
        bytes32 refundAddr;
    }

    struct Criteria {
        uint256 transferDeadline;
        uint64 swapDeadline;
        uint64 amountOutMin;
        bool unwrap;
        uint64 gasDrop;
        bytes customPayload;
    }

    function swap(
        RelayerFees memory relayerFees,
        Recepient memory recipient,
        bytes32 tokenOutAddr,
        uint16 tokenOutChainId,
        Criteria memory criteria,
        address tokenIn,
        uint256 amountIn
    ) external payable returns (uint64 sequence);

    function wrapAndSwapETH(
        RelayerFees memory relayerFees,
        Recepient memory recipient,
        bytes32 tokenOutAddr,
        uint16 tokenOutChainId,
        Criteria memory criteria
    ) external payable returns (uint64 sequence);
}
