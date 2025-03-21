// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for Squid Multicall
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ISquidMulticall {
    enum CallType {
        Default,
        FullTokenBalance,
        FullNativeBalance,
        CollectTokenBalance
    }

    struct Call {
        CallType callType;
        address target;
        uint256 value;
        bytes callData;
        bytes payload;
    }
}
