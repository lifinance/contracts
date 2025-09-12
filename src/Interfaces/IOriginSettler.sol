// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IOriginSettler {
    function openFor(
        bytes calldata order,
        address sponsor,
        bytes calldata signature
    ) external;

    function open(bytes calldata order) external;
}
