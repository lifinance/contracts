// Interface for Stargate V1

// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.17;

// solhint-disable contract-name-camelcase
interface IStargateRouter {
    struct lzTxObj {
        uint256 dstGasForCall;
        uint256 dstNativeAmount;
        bytes dstNativeAddr;
    }

    /// @notice SwapAmount struct
    /// @param amountLD The amount, in Local Decimals, to be swapped
    /// @param minAmountLD The minimum amount accepted out on destination
    struct SwapAmount {
        uint256 amountLD;
        uint256 minAmountLD;
    }

    /// @notice Returns factory address used for creating pools.
    function factory() external view returns (address);

    /// @notice Swap assets cross-chain.
    /// @dev Pass (0, 0, "0x") to lzTxParams
    ///      for 0 additional gasLimit increase, 0 airdrop, at 0x address.
    /// @param dstChainId Destination chainId
    /// @param srcPoolId Source pool id
    /// @param dstPoolId Dest pool id
    /// @param refundAddress Refund adddress. extra gas (if any) is returned to this address
    /// @param amountLD Quantity to swap
    /// @param minAmountLD The min qty you would accept on the destination
    /// @param lzTxParams Additional gas, airdrop data
    /// @param to The address to send the tokens to on the destination
    /// @param payload Additional payload. You can abi.encode() them here
    function swap(
        uint16 dstChainId,
        uint256 srcPoolId,
        uint256 dstPoolId,
        address payable refundAddress,
        uint256 amountLD,
        uint256 minAmountLD,
        lzTxObj memory lzTxParams,
        bytes calldata to,
        bytes calldata payload
    ) external payable;

    /// @notice Swap native assets cross-chain.
    /// @param _dstChainId Destination Stargate chainId
    /// @param _refundAddress Refunds additional messageFee to this address
    /// @param _toAddress The receiver of the destination ETH
    /// @param _swapAmount The amount and the minimum swap amount
    /// @param _lzTxParams The LZ tx params
    /// @param _payload The payload to send to the destination
    function swapETHAndCall(
        uint16 _dstChainId,
        address payable _refundAddress,
        bytes calldata _toAddress,
        SwapAmount memory _swapAmount,
        IStargateRouter.lzTxObj memory _lzTxParams,
        bytes calldata _payload
    ) external payable;

    /// @notice Returns the native gas fee required for swap.
    function quoteLayerZeroFee(
        uint16 dstChainId,
        uint8 functionType,
        bytes calldata toAddress,
        bytes calldata transferAndCallPayload,
        lzTxObj memory lzTxParams
    ) external view returns (uint256 nativeFee, uint256 zroFee);
}
