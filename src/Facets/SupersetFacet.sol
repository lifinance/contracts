// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISupersetSpokePoolManager } from "../Interfaces/ISupersetSpokePoolManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig, InvalidNonEVMReceiver } from "../Errors/GenericErrors.sol";

interface IWETH {
    function deposit() external payable;
}

/// @title SupersetFacet
/// @author LI.FI (https://li.fi)
/// @notice Bridges stablecoins via Superset's hub-and-spoke virtual pools
///         (LayerZero messaging; hub on Arbitrum, spokes on Base/Unichain).
/// @dev This contract is not intended to custody user funds. Any balance held
///      is transient during a single transaction and should not persist across calls.
/// @custom:version 1.0.0
contract SupersetFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @notice Address of the Superset SpokePoolManager on the current chain
    // solhint-disable-next-line immutable-vars-naming
    ISupersetSpokePoolManager public immutable spokePoolManager;

    /// @notice Wrapped-native (WETH) token address on the current chain
    // solhint-disable-next-line immutable-vars-naming
    address public immutable wrappedNative;

    /// Types ///

    /// @dev Superset-specific parameters supplied by the LI.FI backend.
    /// @param path Packed `omniTokenId(32) || fee(3) || ... || omniTokenId(32)` describing
    ///        the multi-hop route on the hub's virtual Uniswap-V3 pools.
    /// @param amountOutMin Slippage floor on destination omni-token (absolute amount).
    /// @param amountOutMinPercent Fraction (1e18 = 100%) used to recompute `amountOutMin`
    ///        post source-swap so positive slippage propagates to the destination floor.
    /// @param refundAddress Address that receives `amountIn` on the source spoke if the
    ///        swap fails. Typically the user.
    /// @param fallbackEoA Pure EOA fall-through if delivery to `bridgeData.receiver` or
    ///        `refundAddress` fails on either chain. Superset validates this is a pure EOA
    ///        on the source; we double-check on the facet for a cheaper revert.
    /// @param deadline Unix timestamp after which the hub will reject the request.
    /// @param toEid LayerZero endpoint ID of the destination spoke chain.
    /// @param options LayerZero executor options for the source → hub request.
    /// @param lzFee Native value forwarded to the spoke (`msg.value`) to cover all
    ///        three LayerZero messages (request + two responses).
    struct SupersetData {
        bytes path;
        uint256 amountOutMin;
        uint64 amountOutMinPercent;
        address refundAddress;
        address fallbackEoA;
        uint256 deadline;
        uint32 toEid;
        bytes options;
        uint256 lzFee;
    }

    /// Errors ///

    /// @notice Thrown when `fallbackEoA` is a contract (i.e. has bytecode).
    error InvalidFallbackEoA(address fallbackEoA);

    /// @notice Thrown when `msg.value` does not cover the declared `lzFee`
    ///         (plus `minAmount` for native bridges).
    error InsufficientNativeValue();

    /// @notice Thrown when `SupersetData.path` is shorter than the minimum encoding
    ///         (one hop = 32 + 3 + 32 = 67 bytes).
    error InvalidSupersetPath();

    /// Constructor ///

    /// @param _spokePoolManager Superset SpokePoolManager on the current chain
    /// @param _wrappedNative Wrapped-native token address on the current chain
    constructor(
        ISupersetSpokePoolManager _spokePoolManager,
        address _wrappedNative
    ) {
        if (
            address(_spokePoolManager) == address(0) ||
            _wrappedNative == address(0)
        ) {
            revert InvalidConfig();
        }
        spokePoolManager = _spokePoolManager;
        wrappedNative = _wrappedNative;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Superset
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _supersetData Superset-specific parameters
    function startBridgeTokensViaSuperset(
        ILiFi.BridgeData calldata _bridgeData,
        SupersetData calldata _supersetData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _validateSupersetData(_bridgeData, _supersetData);
        _enforceNativeValue(_bridgeData, _supersetData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

        _startBridge(_bridgeData, _supersetData);
    }

    /// @notice Performs a swap before bridging via Superset
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _swapData Source-chain swap(s) executed before bridging
    /// @param _supersetData Superset-specific parameters
    function swapAndStartBridgeTokensViaSuperset(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        SupersetData calldata _supersetData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _validateSupersetData(_bridgeData, _supersetData);

        // Reserve lzFee from msg.value so it isn't swept back to the user
        // when SwapperV2 refunds leftover native.
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _supersetData.lzFee
        );

        // Adjust destination slippage floor for positive source-side slippage
        // ([CONV:FACET-REQS] positive slippage handling).
        SupersetData memory modifiedSupersetData = _supersetData;
        modifiedSupersetData.amountOutMin =
            (_bridgeData.minAmount * _supersetData.amountOutMinPercent) /
            1e18;

        _startBridge(_bridgeData, modifiedSupersetData);
    }

    /// Internal Methods ///

    /// @dev Validates Superset-specific data. Reverts on misconfiguration.
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _supersetData Superset-specific parameters
    function _validateSupersetData(
        ILiFi.BridgeData memory _bridgeData,
        SupersetData calldata _supersetData
    ) internal view {
        // Superset has no non-EVM spokes; reject explicitly.
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            revert InvalidNonEVMReceiver();
        }

        // Minimum single-hop encoding is omniTokenId(32) || fee(3) || omniTokenId(32) = 67 bytes.
        if (_supersetData.path.length < 67) {
            revert InvalidSupersetPath();
        }

        // Defense-in-depth: Superset already validates this on the source side
        // (`SwapDelivery.resolveAndValidateFallbackEoA`); reverting earlier here
        // saves gas on bad inputs.
        if (_supersetData.fallbackEoA.code.length != 0) {
            revert InvalidFallbackEoA(_supersetData.fallbackEoA);
        }
    }

    /// @dev Enforces that msg.value covers lzFee (and minAmount for native bridges).
    ///      Only called from the bridge-only entry; the swap variant reserves lzFee
    ///      via `_depositAndSwap`, which itself fails if msg.value is insufficient.
    function _enforceNativeValue(
        ILiFi.BridgeData calldata _bridgeData,
        SupersetData calldata _supersetData
    ) internal view {
        uint256 required = _supersetData.lzFee;
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            required += _bridgeData.minAmount;
        }
        if (msg.value < required) {
            revert InsufficientNativeValue();
        }
    }

    /// @dev Bridge execution: wraps native if needed, approves, calls Superset.
    /// @param _bridgeData Core LI.FI bridge data
    /// @param _supersetData Superset-specific parameters
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        SupersetData memory _supersetData
    ) internal {
        address inputToken = _bridgeData.sendingAssetId;

        if (LibAsset.isNativeAsset(inputToken)) {
            // Superset's spoke pulls tokens via `safeTransferFrom`, so native must
            // be wrapped locally. The path's first omniTokenId must map to WETH on
            // this chain in Superset's `OmniTokenAddressBook`.
            IWETH(wrappedNative).deposit{ value: _bridgeData.minAmount }();
            inputToken = wrappedNative;
        }

        LibAsset.maxApproveERC20(
            IERC20(inputToken),
            address(spokePoolManager),
            _bridgeData.minAmount
        );

        spokePoolManager.multiHopSwapWithOutputChain{
            value: _supersetData.lzFee
        }(
            _supersetData.path,
            _bridgeData.minAmount,
            _supersetData.amountOutMin,
            _bridgeData.receiver,
            _supersetData.refundAddress,
            _supersetData.fallbackEoA,
            _supersetData.deadline,
            _supersetData.toEid,
            _supersetData.options
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
