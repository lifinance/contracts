// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IGravityRouter {
    function sendToCosmos(
        address _tokenContract,
        string calldata _destination,
        uint256 _amount
    ) external payable;
}
