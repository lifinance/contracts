// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for Algebra quoter
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IAlgebraQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint160 limitSqrtPrice
    ) external returns (uint256 amountOut, uint16 fee);

    function quoteExactInput(
        bytes memory path,
        uint256 amountIn
    ) external returns (uint256 amountOut, uint16[] memory fees);

    function quoteExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint160 limitSqrtPrice
    ) external returns (uint256 amountIn, uint16 fee);

    function quoteExactOutput(
        bytes memory path,
        uint256 amountOut
    ) external returns (uint256 amountIn, uint16[] memory fees);

    function getPool(
        address tokenA,
        address tokenB
    ) external view returns (address);
}
