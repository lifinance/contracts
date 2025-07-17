// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for KatanaV3 Aggregate Router
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IKatanaV3AggregateRouter {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs
    ) external payable;
}
