// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title ContractBasedNativeWrapperFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles wrapping/unwrapping of dual-purpose native tokens that function as both native and ERC-20
/// @dev Some blockchains implement native tokens with "token duality" - they function both as native currency
///      and as ERC-20 compatible tokens without requiring wrapping/unwrapping. Examples include:
///
///      CELO Token Duality (0x471EcE3750Da237f93B8E339c536989b8978a438):
///      - Functions as both native currency (like ETH) and ERC-20 token simultaneously
///      - Native transfers work like ETH transfers on Ethereum
///      - ERC-20 transfers use standard interface but trigger native transfers via precompile
///      - balanceOf() returns native balance directly (no separate storage)
///      - No deposit()/withdraw() methods needed - transfers are always native
///
///      This facet provides simple transfer-based operations for such tokens,
///      since they don't require actual wrapping/unwrapping operations.
/// @custom:version 1.0.0
contract ContractBasedNativeWrapperFacet is BaseRouteConstants {
    using LibPackedStream for uint256;

    // ==== External Functions ====

    /// @notice Unwraps dual-purpose native token
    /// @dev Dual-purpose native tokens (like CELO) don't have withdraw() methods since they're always native.
    ///      ERC-20 transfers automatically trigger native transfers via precompile, so we just transfer directly.
    /// @param swapData Encoded swap parameters [destinationAddress]
    /// @param from Token source. If from == msg.sender, pull tokens via transferFrom.
    ///             Otherwise, assume tokens are already held by this contract.
    /// @param tokenIn Dual-purpose native token address
    /// @param amountIn Amount of tokens to "unwrap" (actually just transfer natively)
    function unwrapContractBasedNative(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external payable {
        address destinationAddress;
        assembly {
            // swapData layout: [length (32 bytes)][data...]
            // We want the first 20 bytes of data, right-shifted to get address
            destinationAddress := shr(96, mload(add(swapData, 32)))
        }

        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }

        // For dual-purpose native tokens, there's no "withdraw" - ERC-20 transfers automatically
        // trigger native transfers via precompile, so we just transfer the tokens directly
        if (destinationAddress != address(this)) {
            LibAsset.transferERC20(tokenIn, destinationAddress, amountIn);
        }
    }

    /// @notice Wraps native tokens to dual-purpose native token
    /// @dev Dual-purpose native tokens (like CELO) don't have deposit() methods since they're always native.
    ///      ERC-20 transfers automatically trigger native transfers via precompile, so we just transfer directly.
    /// @param swapData Encoded swap parameters [dualPurposeNativeToken, destinationAddress]
    /// @param amountIn Amount of native tokens to "wrap" (actually just transfer natively)
    function wrapContractBasedNative(
        bytes memory swapData,
        address, // from is not used
        address, // tokenIn is not used
        uint256 amountIn
    ) external payable {
        uint256 stream = LibPackedStream.createStream(swapData);

        address contractBasedNativeToken = stream.readAddress();
        address destinationAddress = stream.readAddress();

        if (contractBasedNativeToken == address(0)) {
            revert InvalidCallData();
        }

        // For contract-based native tokens, there's no "deposit" - we just transfer the tokens directly
        // since these tokens behave like native ETH but are actually ERC20 contracts
        if (destinationAddress != address(this)) {
            LibAsset.transferERC20(
                contractBasedNativeToken,
                destinationAddress,
                amountIn
            );
        }
    }
}
