// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.13;

interface IStargateRouter {
    struct lzTxObj {
        uint256 dstGasForCall;
        uint256 dstNativeAmount;
        bytes dstNativeAddr;
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

    /// @notice Returns the native gas fee required for swap.
    function quoteLayerZeroFee(
        uint16 dstChainId,
        uint8 functionType,
        bytes calldata toAddress,
        bytes calldata transferAndCallPayload,
        lzTxObj memory lzTxParams
    ) external view returns (uint256 nativeFee, uint256 zroFee);
}

interface IFactory {
    /// @notice Returns PoolInfo for poolId
    function getPool(uint256) external view returns (address);
}

interface IPool {
    /// @notice Returns PoolInfo for poolId
    function token() external view returns (address);
}
