// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ISquidMulticall } from "./ISquidMulticall.sol";

/// @title Interface for Squid Router
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
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
