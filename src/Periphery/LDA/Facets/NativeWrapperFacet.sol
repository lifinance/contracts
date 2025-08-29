// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { IWETH } from "lifi/Interfaces/IWETH.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

/// @title NativeWrapperFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles wrapping/unwrapping of native tokens (ETH <-> WETH)
/// @custom:version 1.0.0
contract NativeWrapperFacet is BaseRouteConstants {
    using LibPackedStream for uint256;

    // ==== External Functions ====
    /// @notice Unwraps WETH to native ETH
    /// @dev Handles unwrapping WETH and sending native ETH to recipient
    /// @param swapData Encoded swap parameters [destinationAddress]
    /// @param from Token source. If from == msg.sender, pull tokens via transferFrom.
    ///             Otherwise, assume tokens are already held by this contract (e.g., address(this) or FUNDS_IN_RECEIVER).
    /// @param tokenIn WETH token address
    /// @param amountIn Amount of WETH to unwrap
    function unwrapNative(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external {
        uint256 stream = LibPackedStream.createStream(swapData);

        address destinationAddress = stream.readAddress();

        if (destinationAddress == address(0)) {
            revert InvalidCallData();
        }

        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }

        IWETH(tokenIn).withdraw(amountIn);
        if (destinationAddress != address(this)) {
            LibAsset.transferNativeAsset(
                payable(destinationAddress),
                amountIn
            );
        }
    }

    /// @notice Wraps native ETH to WETH
    /// @dev Handles wrapping native ETH to WETH and sending to recipient
    /// @param swapData Encoded swap parameters [wrappedNative, destinationAddress]
    /// @param amountIn Amount of native ETH to wrap
    function wrapNative(
        bytes memory swapData,
        address, // from is not used
        address, // tokenIn is not used
        uint256 amountIn
    ) external payable {
        uint256 stream = LibPackedStream.createStream(swapData);

        address wrappedNative = stream.readAddress();
        address destinationAddress = stream.readAddress();

        if (wrappedNative == address(0) || destinationAddress == address(0)) {
            revert InvalidCallData();
        }

        IWETH(wrappedNative).deposit{ value: amountIn }();
        if (destinationAddress != address(this)) {
            LibAsset.transferERC20(
                wrappedNative,
                destinationAddress,
                amountIn
            );
        }
    }
}
