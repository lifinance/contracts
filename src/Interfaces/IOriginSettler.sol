// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { StandardOrder } from "./IOIF.sol";

/**
 * @title IOriginSettler
 * @notice Interface for opening origin-settlement orders (with and without sponsor authorization).
 * @author LI.FI (https://li.fi)
 * @custom:version 1.0.0
 */
interface IOriginSettler {
    function openFor(
        StandardOrder calldata order,
        address sponsor,
        bytes calldata signature
    ) external;

    function open(StandardOrder calldata order) external;
}
