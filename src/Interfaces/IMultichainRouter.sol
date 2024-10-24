// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IMultichainRouter {
    function anySwapOutUnderlying(
        address token,
        address to,
        uint256 amount,
        uint256 toChainID
    ) external;

    function anySwapOut(
        address token,
        address to,
        uint256 amount,
        uint256 toChainID
    ) external;

    function anySwapOutNative(
        address token,
        address to,
        uint256 toChainID
    ) external payable;

    function wNATIVE() external returns (address);
}
