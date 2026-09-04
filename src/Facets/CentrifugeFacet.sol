// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICentrifugeTokenBridge } from "../Interfaces/ICentrifugeTokenBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidCallData, InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title CentrifugeFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging Centrifuge share tokens via the Centrifuge TokenBridge
/// @custom:version 1.0.0
/// @dev This facet is not designed to custody user funds. The bridged share tokens and the native
///      messaging fee are only held by the Diamond transiently, within a single call: the share
///      tokens are pulled in, approved to the TokenBridge and immediately consumed by it, and the
///      native fee is forwarded to the bridge. Any excess native left after the call is returned to
///      `CentrifugeData.refundRecipient` by `refundExcessNative`, so no balance should ever persist.
contract CentrifugeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The Centrifuge TokenBridge on the source chain.
    ICentrifugeTokenBridge public immutable TOKEN_BRIDGE;

    /// Types ///

    /// @param nativeFee The native amount forwarded to the TokenBridge to pay for the cross-chain
    ///        message. Centrifuge exposes no on-chain quote, so this value is supplied by the
    ///        LI.FI backend. Underpaying makes the Centrifuge Gateway revert; overpaying is
    ///        refunded to `refundRecipient` by the bridge itself.
    /// @param refundRecipient Address that receives swap leftovers and positive slippage from
    ///        pre-bridge swaps, any excess source-side native, and the messaging-fee overage that
    ///        the Centrifuge Gateway refunds. Must accept plain native transfers: a refundRecipient
    ///        that rejects them reverts the whole bridge (self-inflicted).
    struct CentrifugeData {
        uint256 nativeFee;
        address refundRecipient;
    }

    /// Constructor ///

    /// @notice Initializes the CentrifugeFacet
    /// @param _tokenBridge The address of the Centrifuge TokenBridge on the source chain
    constructor(ICentrifugeTokenBridge _tokenBridge) {
        if (address(_tokenBridge) == address(0)) {
            revert InvalidConfig();
        }
        TOKEN_BRIDGE = _tokenBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Centrifuge
    /// @param _bridgeData The core information needed for bridging
    /// @param _centrifugeData Data specific to Centrifuge
    function startBridgeTokensViaCentrifuge(
        ILiFi.BridgeData memory _bridgeData,
        CentrifugeData calldata _centrifugeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_centrifugeData.refundRecipient))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateCentrifugeData(_centrifugeData);

        // The bridge's messaging fee must be paid from msg.value, never from diamond balance
        if (_centrifugeData.nativeFee > msg.value) {
            revert InvalidCallData();
        }

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _centrifugeData);
    }

    /// @notice Performs a swap before bridging via Centrifuge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _centrifugeData Data specific to Centrifuge
    function swapAndStartBridgeTokensViaCentrifuge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CentrifugeData calldata _centrifugeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(_centrifugeData.refundRecipient))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateCentrifugeData(_centrifugeData);

        // NOTE: nativeFee is intentionally NOT checked against msg.value here (unlike the
        // non-swap path): the fee may be funded by an ERC20->native pre-swap, whose output
        // the nativeReserve below keeps in the diamond for the TokenBridge call.
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(_centrifugeData.refundRecipient),
            _centrifugeData.nativeFee
        );

        _startBridge(_bridgeData, _centrifugeData);
    }

    /// Internal Methods ///

    /// @dev Validates the Centrifuge-specific calldata that both entrypoints share
    /// @param _centrifugeData Data specific to Centrifuge
    function _validateCentrifugeData(
        CentrifugeData calldata _centrifugeData
    ) private pure {
        // refundExcessNative sends excess native to refundRecipient; with a zero address that
        // transfer would only revert once there actually is an excess - a data-dependent late
        // revert. Fail fast instead.
        if (_centrifugeData.refundRecipient == address(0)) {
            revert InvalidCallData();
        }

        // Centrifuge has no on-chain fee quote, so a zero fee cannot be distinguished from a
        // missing one. Every cross-chain message costs something, so a zero fee is always a
        // malformed request - reject it here rather than letting the Gateway decide.
        if (_centrifugeData.nativeFee == 0) {
            revert InvalidCallData();
        }
    }

    /// @dev Contains the business logic for bridging via Centrifuge
    /// @param _bridgeData The core information needed for bridging
    /// @param _centrifugeData Data specific to Centrifuge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CentrifugeData calldata _centrifugeData
    ) internal {
        // The TokenBridge pulls the share tokens from the caller (this Diamond) with a plain
        // transferFrom, so it needs an allowance despite its "no approval needed" source comment,
        // which refers to the later spoke hop.
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(TOKEN_BRIDGE),
            _bridgeData.minAmount
        );

        // The receiver is derived from bridgeData rather than taken from CentrifugeData so that
        // the bridged destination can never disagree with the emitted event. validateBridgeData
        // already guarantees it is non-zero. This makes the facet EVM-only: a non-EVM receiver
        // would need a dedicated field and a version bump.
        // solhint-disable-next-line check-send-result
        TOKEN_BRIDGE.send{ value: _centrifugeData.nativeFee }(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            LibBytes.toBytes32(_bridgeData.receiver),
            _bridgeData.destinationChainId,
            _centrifugeData.refundRecipient
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
