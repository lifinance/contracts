// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IKatanaV3Governance
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IKatanaV3Governance {
    function getRouter() external view returns (address);
}
