// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IOFTV2 } from "../Interfaces/IOFTV2.sol";

interface IOFTV2WithFee {
    function sendFrom(
        address _from,
        uint16 _dstChainId,
        bytes32 _toAddress,
        uint256 _amount,
        uint256 _minAmount,
        IOFTV2.LzCallParams memory _callParams
    ) external payable;
}
