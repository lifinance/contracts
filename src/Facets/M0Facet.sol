// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IM0OrderBook } from "../Interfaces/IM0OrderBook.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
// solhint-disable-next-line max-line-length
import { InformationMismatch, InvalidAmount, InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { FixedPointMathLib } from "solady/utils/FixedPointMathLib.sol";
import { SafeCastLib } from "solady/utils/SafeCastLib.sol";

/// @title M0Facet
/// @author LI.FI (https://li.fi)
/// @notice Bridges and swaps tokens by opening escrowed limit orders on the M0 OrderBook
/// @dev    The OrderBook is not a bridge in the usual sense: `openOrder` escrows the
///         sending asset and returns, and a solver settles the order later on the
///         destination chain. Same-chain orders (`destinationChainId == block.chainid`)
///         take the same path and are therefore asynchronous escrow rather than atomic
///         swaps, which is why both entrypoints emit `LiFiTransferStarted` rather than
///         `GenericSwapCompleted`.
///
///         The facet validates only the bindings between `bridgeData` and `M0Data` and
///         leaves every protocol rule (deadline, zero amounts, solver/recipient
///         collision, destination support, pause state) to the OrderBook. The OrderBook
///         sits behind an upgradeable proxy, so mirroring its internal rules here would
///         bake in assumptions that an upgrade can invalidate.
/// @custom:version 1.0.0
contract M0Facet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Constants ///

    /// @dev M0's chain id for Solana. LI.FI uses its own made-up id for non-EVM chains
    ///      (`LIFI_CHAIN_ID_SOLANA`), so the two have to be translated at the boundary.
    uint32 private constant M0_CHAIN_ID_SOLANA = 1399811149;

    /// Storage ///

    /// @notice The M0 OrderBook on the current chain.
    IM0OrderBook public immutable M0_ORDER_BOOK;

    /// Types ///

    /// @param receiverAddress Destination-chain receiver as bytes32. For EVM destinations it
    ///        must equal `bridgeData.receiver`; for non-EVM destinations `bridgeData.receiver`
    ///        is the `NON_EVM_ADDRESS` sentinel and this carries the real receiver.
    /// @param refundRecipient Source-chain address that receives leftover swap input and
    ///        intermediate assets swept by the swap helper, plus excess native. Must accept
    ///        plain native transfers. Note this is not where positive slippage goes: surplus
    ///        on the final receiving asset stays in the diamond and is escrowed, which is
    ///        what `amountOut` scaling below prices in.
    /// @param orderOwner Becomes `OrderParams.sender`: the order owner on the OrderBook. It
    ///        always receives the origin-chain refund when the order is cancelled, but it
    ///        only holds a pre-deadline cancellation right on same-chain orders — the
    ///        OrderBook processes a cancellation on the destination chain, where a
    ///        cross-chain order's origin is remote and only `recipient` may cancel before
    ///        `fillDeadline`. After `fillDeadline` cancellation is permissionless either way.
    ///        This is deliberately separate from `refundRecipient` because the OrderBook
    ///        refund is issued by the protocol long after this call returns, while
    ///        `refundRecipient` is paid within it.
    /// @param tokenOut Destination-chain token as bytes32.
    /// @param solver Solver exclusively allowed to fill the order; `bytes32(0)` opens it to all.
    /// @param amountOut Amount of `tokenOut` requested. Acts as a limit price: on the swap
    ///        entrypoint it is quoted against the pre-swap `bridgeData.minAmount` and scaled
    ///        by the realized swap output so the quoted exchange rate is preserved.
    /// @param fillDeadline Unix timestamp after which the order can no longer be filled.
    struct M0Data {
        bytes32 receiverAddress;
        address refundRecipient;
        address orderOwner;
        bytes32 tokenOut;
        bytes32 solver;
        uint128 amountOut;
        uint32 fillDeadline;
    }

    /// Constructor ///

    /// @notice Initializes the M0Facet
    /// @param _orderBook The address of the M0 OrderBook on the current chain
    constructor(IM0OrderBook _orderBook) {
        if (address(_orderBook) == address(0)) {
            revert InvalidConfig();
        }
        M0_ORDER_BOOK = _orderBook;
    }

    /// Modifiers ///

    /// @notice Validates bridge data for M0 orders.
    /// @dev Omits the same-network guard of `validateBridgeData` because the OrderBook
    ///      supports same-chain orders.
    /// @param _bridgeData The core information needed for bridging
    modifier validateBridgeDataM0(ILiFi.BridgeData memory _bridgeData) {
        if (LibUtil.isZeroAddress(_bridgeData.receiver)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.minAmount == 0) {
            revert InvalidAmount();
        }
        _;
    }

    /// External Methods ///

    /// @notice Opens an M0 order for the sending asset
    /// @param _bridgeData The core information needed for bridging
    /// @param _m0Data Data specific to M0
    function startBridgeTokensViaM0(
        ILiFi.BridgeData memory _bridgeData,
        M0Data calldata _m0Data
    )
        external
        nonReentrant
        validateBridgeDataM0(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateM0Data(_bridgeData, _m0Data);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _m0Data, _m0Data.amountOut);
    }

    /// @notice Performs a swap before opening an M0 order
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _m0Data Data specific to M0
    function swapAndStartBridgeTokensViaM0(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        M0Data calldata _m0Data
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_m0Data.refundRecipient))
        validateBridgeDataM0(_bridgeData)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateM0Data(_bridgeData, _m0Data);

        // The final swap output is what gets escrowed, so it must be the sending asset:
        // _depositAndSwap measures the received amount in the last swap's receivingAssetId
        // while the escrow below acts on sendingAssetId. An empty array is left to
        // _depositAndSwap, which reverts NoSwapDataProvided.
        if (
            _swapData.length != 0 &&
            _swapData[_swapData.length - 1].receivingAssetId !=
            _bridgeData.sendingAssetId
        ) {
            revert InformationMismatch();
        }

        uint256 quotedAmountIn = _bridgeData.minAmount;

        uint256 receivedAmount = _depositAndSwap(
            _bridgeData.transactionId,
            quotedAmountIn,
            _swapData,
            payable(_m0Data.refundRecipient)
        );

        // amountOut is a limit price, so it is scaled by the realized swap result to keep
        // the quoted exchange rate intact. Forwarding the unscaled quote would hand the
        // swap's positive slippage to the solver as a better rate; scaling instead buys
        // proportionally more tokenOut for the user on the destination chain.
        uint256 scaledAmountOut = FixedPointMathLib.mulDiv(
            _m0Data.amountOut,
            receivedAmount,
            quotedAmountIn
        );
        // Not a truncation guard: _depositAndSwap already enforces
        // receivedAmount >= quotedAmountIn > 0, so the scale never rounds a non-zero
        // amountOut down to zero. This only catches a zero amountOut, turning the
        // OrderBook's AmountOutZero into an immediate local revert.
        if (scaledAmountOut == 0) {
            revert InvalidAmount();
        }

        _bridgeData.minAmount = receivedAmount;

        _startBridge(
            _bridgeData,
            _m0Data,
            SafeCastLib.toUint128(scaledAmountOut)
        );
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for opening an order on the M0 OrderBook
    /// @param _bridgeData The core information needed for bridging
    /// @param _m0Data Data specific to M0
    /// @param _amountOut The requested destination amount, already scaled on the swap path
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        M0Data calldata _m0Data,
        uint128 _amountOut
    ) internal {
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(M0_ORDER_BOOK),
            _bridgeData.minAmount
        );

        (uint256 m0ChainId, ) = _resolveDestination(
            _bridgeData.destinationChainId
        );

        M0_ORDER_BOOK.openOrder(
            IM0OrderBook.OrderParams({
                destChainId: SafeCastLib.toUint32(m0ChainId),
                fillDeadline: _m0Data.fillDeadline,
                tokenIn: _bridgeData.sendingAssetId,
                tokenOut: _m0Data.tokenOut,
                amountIn: SafeCastLib.toUint128(_bridgeData.minAmount),
                amountOut: _amountOut,
                recipient: _m0Data.receiverAddress,
                solver: _m0Data.solver,
                sender: _m0Data.orderOwner
            })
        );

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _m0Data.receiverAddress
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// Private Methods ///

    /// @dev Validates the bindings between bridgeData and M0Data. Protocol-level rules are
    ///      intentionally left to the OrderBook.
    /// @param _bridgeData The core information needed for bridging
    /// @param _m0Data Data specific to M0
    function _validateM0Data(
        ILiFi.BridgeData memory _bridgeData,
        M0Data calldata _m0Data
    ) private pure {
        // msg.sender may be a relayer or the Permit2Proxy, so value that belongs to the
        // user needs an explicit sink rather than defaulting to the caller.
        if (_m0Data.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        // The OrderBook rejects a zero sender, but failing here keeps the order owner an
        // explicit decision rather than something that happens to be non-zero.
        if (_m0Data.orderOwner == address(0)) {
            revert InvalidCallData();
        }

        // The OrderBook never validates tokenOut. A zero value would escrow the sending
        // asset into an order no solver can ever fill.
        if (_m0Data.tokenOut == bytes32(0)) {
            revert InvalidCallData();
        }

        // The receiver format is bound to the destination. Without this, a non-EVM order
        // could carry a plain EVM receiver — escrowing to a left-padded address that means
        // nothing on the destination chain, and skipping BridgeToNonEVMChainBytes32 — while
        // an EVM order could use the sentinel and escape the receiver equality check
        // entirely, letting receiverAddress point anywhere.
        (, bool isNonEVMDestination) = _resolveDestination(
            _bridgeData.destinationChainId
        );

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            if (!isNonEVMDestination) {
                revert InvalidReceiver();
            }
            if (_m0Data.receiverAddress == bytes32(0)) {
                revert InvalidNonEVMReceiver();
            }
        } else {
            if (isNonEVMDestination) {
                revert InvalidReceiver();
            }
            // The OrderBook only ever sees receiverAddress, so a mismatch would deliver to
            // an address the emitted LiFiTransferStarted does not name.
            if (
                _m0Data.receiverAddress !=
                LibBytes.toBytes32(_bridgeData.receiver)
            ) {
                revert InformationMismatch();
            }
            // tokenOut and solver are only resolved on the destination chain, where the
            // OrderBook narrows both with TypeConverter.toAddress — solver unconditionally,
            // before it checks the open-to-all bytes32(0). A value with non-zero high bytes
            // opens and escrows here, then reverts every fill attempt, stranding the
            // deposit until fillDeadline. Both revert NotAnAddress; bytes32(0) passes, so
            // an open-to-all order still works.
            LibBytes.toAddress(_m0Data.tokenOut);
            LibBytes.toAddress(_m0Data.solver);
        }
    }

    /// @dev Maps a LI.FI destination chain id onto the OrderBook's id space and says whether
    ///      the destination is non-EVM. Every non-EVM chain has two ids — the LI.FI one
    ///      callers pass and M0's own, which is what the OrderBook stores — and both halves
    ///      belong here so a chain cannot gain a translation without also being rejected in
    ///      its raw M0 form. Passed raw it would survive the narrowing in `_startBridge`
    ///      untouched and be treated as an EVM destination, escrowing to a left-padded EVM
    ///      address no account on that chain owns and emitting no
    ///      `BridgeToNonEVMChainBytes32`. Rejected with the same error as the other bindings
    ///      rather than `InvalidDestinationChain`, whose selector the OrderBook already uses
    ///      for its own unsupported-destination check.
    /// @dev Returns the id unnarrowed: narrowing here would make an oversized id revert
    ///      `Overflow` during validation, ahead of the receiver-format check that currently
    ///      rejects the untranslatable non-EVM chains with the more specific
    ///      `InvalidReceiver`.
    /// @param _destinationChainId The LI.FI destination chain id
    /// @return m0ChainId The destination chain id the OrderBook expects, not yet narrowed
    /// @return isNonEVM Whether the destination requires the `NON_EVM_ADDRESS` sentinel
    function _resolveDestination(
        uint256 _destinationChainId
    ) private pure returns (uint256 m0ChainId, bool isNonEVM) {
        if (_destinationChainId == LIFI_CHAIN_ID_SOLANA) {
            return (M0_CHAIN_ID_SOLANA, true);
        }
        if (_destinationChainId == M0_CHAIN_ID_SOLANA) {
            revert InvalidCallData();
        }
        return (_destinationChainId, false);
    }
}
