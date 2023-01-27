// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAcrossSpokePool } from "../Interfaces/IAcrossSpokePool.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { CannotBridgeToSameNetwork } from "src/Errors/GenericErrors.sol";

/// @title Across Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol
contract AcrossFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.across");

    /// @notice The contract address of the spoke pool on the source chain.
    IAcrossSpokePool private immutable spokePool;

    /// @notice The WETH address on the current chain.
    address private immutable wrappedNative;

    /// Errors
    error QuoteTimeout();

    /// Types ///

    /// @param relayerFeePct The relayer fee in token percentage with 18 decimals.
    /// @param quoteTimestamp The timestamp associated with the suggested fee.
    struct AcrossData {
        uint64 relayerFeePct;
        uint32 quoteTimestamp;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _spokePool The contract address of the spoke pool on the source chain.
    /// @param _wrappedNative The address of the wrapped native token on the source chain.
    constructor(IAcrossSpokePool _spokePool, address _wrappedNative) {
        spokePool = _spokePool;
        wrappedNative = _wrappedNative;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function startBridgeTokensViaAcross(
        ILiFi.BridgeData memory _bridgeData,
        AcrossData calldata _acrossData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _acrossData);
    }

    /// @notice Performs a swap before bridging via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _acrossData data specific to Across
    function swapAndStartBridgeTokensViaAcross(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AcrossData memory _acrossData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _acrossData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AcrossData memory _acrossData
    ) internal {
        if (block.chainid == _bridgeData.destinationChainId)
            revert CannotBridgeToSameNetwork();
        bool isNative = _bridgeData.sendingAssetId == LibAsset.NATIVE_ASSETID;
        address sendingAsset = _bridgeData.sendingAssetId;
        if (isNative) sendingAsset = wrappedNative;
        else
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(spokePool),
                _bridgeData.minAmount
            );

        spokePool.deposit{ value: isNative ? _bridgeData.minAmount : 0 }(
            _bridgeData.receiver,
            sendingAsset,
            _bridgeData.minAmount,
            _bridgeData.destinationChainId,
            _acrossData.relayerFeePct,
            _acrossData.quoteTimestamp
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
