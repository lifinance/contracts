// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ISquidMulticall } from "./ISquidMulticall.sol";

interface ISquidRouter {
    event CrossMulticallExecuted(bytes32 indexed payloadHash);
    event CrossMulticallFailed(
        bytes32 indexed payloadHash,
        bytes reason,
        address indexed refundRecipient
    );

    function bridgeCall(
        string calldata destinationChain,
        string calldata bridgedTokenSymbol,
        uint256 amount,
        ISquidMulticall.Call[] calldata calls,
        address refundRecipient,
        bool forecallEnabled
    ) external payable;

    function callBridge(
        address token,
        uint256 amount,
        string calldata destinationChain,
        string calldata destinationAddress,
        string calldata bridgedTokenSymbol,
        ISquidMulticall.Call[] calldata calls
    ) external payable;

    function callBridgeCall(
        address token,
        uint256 amount,
        string calldata destinationChain,
        string calldata bridgedTokenSymbol,
        ISquidMulticall.Call[] calldata sourceCalls,
        ISquidMulticall.Call[] calldata destinationCalls,
        address refundRecipient,
        bool forecallEnabled
    ) external payable;
}
