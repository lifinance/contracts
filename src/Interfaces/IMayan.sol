// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface IMayan {
    struct PermitParams {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function forwardEth(
        address mayanProtocol,
        bytes calldata protocolData
    ) external payable;

    function forwardERC20(
        address tokenIn,
        uint256 amountIn,
        PermitParams calldata permitParams,
        address mayanProtocol,
        bytes calldata protocolData
    ) external payable;
}
