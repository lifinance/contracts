// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { StandardOrder } from "./IOIF.sol";

interface IOriginSettler {
    function openFor(
        StandardOrder calldata order,
        address sponsor,
        bytes calldata signature
    ) external;

    function open(StandardOrder calldata order) external;
}
