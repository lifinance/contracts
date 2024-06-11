// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { ISquidMulticall } from "./ISquidMulticall.sol";

interface ISquidRouter {
    function bridgeCall(
        string calldata bridgedTokenSymbol,
        uint256 amount,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address gasRefundRecipient,
        bool enableExpress
    ) external payable;

    function callBridge(
        address token,
        uint256 amount,
        ISquidMulticall.Call[] calldata calls,
        string calldata bridgedTokenSymbol,
        string calldata destinationChain,
        string calldata destinationAddress
    ) external payable;

    function callBridgeCall(
        address token,
        uint256 amount,
        ISquidMulticall.Call[] calldata calls,
        string calldata bridgedTokenSymbol,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address gasRefundRecipient,
        bool enableExpress
    ) external payable;
}
