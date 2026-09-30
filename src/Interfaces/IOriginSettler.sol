// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { StandardOrder } from "./IOpenIntentFramework.sol";

/// @title IOriginSettler
/// @notice Interface for opening origin-settlement orders (with and without sponsor authorization).
/// @author LI.FI (https://li.fi)
/// @custom:version 1.1.0
/// @dev Mirrors OIF `InputSettlerEscrow`, where native inputs (token 0) are funded by msg.value, which must equal their sum exactly.
interface IOriginSettler {
    /// @notice Opens an order for `order.user`, collecting inputs from `sponsor`.
    /// @param order The order to open
    /// @param sponsor The address inputs are collected from
    /// @param signature Sponsor authorization; native inputs are only accepted on the self-sponsored path
    function openFor(
        StandardOrder calldata order,
        address sponsor,
        bytes calldata signature
    ) external payable;

    /// @notice Opens an order for `order.user`, collecting inputs from msg.sender.
    /// @param order The order to open
    function open(StandardOrder calldata order) external payable;
}
