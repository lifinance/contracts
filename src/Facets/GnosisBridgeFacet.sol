// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGnosisBridgeRouter } from "../Interfaces/IGnosisBridgeRouter.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, InvalidSendingToken } from "../Errors/GenericErrors.sol";

/// @title Gnosis Bridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Gnosis bridge router
/// @custom:version 2.0.0
contract GnosisBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The DAI address on the Ethereum mainnet
    address private constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    /// @notice The USDS address on the Ethereum mainnet
    address private constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;

    /// @notice The chain id of Gnosis.
    uint64 private constant GNOSIS_CHAIN_ID = 100;

    /// @notice The contract address of the gnosis bridge router on the Ethereum mainnet
    IGnosisBridgeRouter private immutable GNOSIS_BRIDGE_ROUTER;

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _gnosisBridgeRouter The contract address of the gnosis bridge router on the Ethereum mainnet
    constructor(IGnosisBridgeRouter _gnosisBridgeRouter) {
        if (address(_gnosisBridgeRouter) == address(0)) {
            revert InvalidConfig();
        }
        GNOSIS_BRIDGE_ROUTER = _gnosisBridgeRouter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via GnosisBridgeRouter
    /// @param _bridgeData the core information needed for bridging
    function startBridgeTokensViaGnosisBridge(
        ILiFi.BridgeData memory _bridgeData
    )
        external
        nonReentrant
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, GNOSIS_CHAIN_ID)
    {
        if (
            _bridgeData.sendingAssetId != DAI &&
            _bridgeData.sendingAssetId != USDS
        ) {
            revert InvalidSendingToken();
        }
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via GnosisBridgeRouter
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapAndStartBridgeTokensViaGnosisBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        onlyAllowDestinationChain(_bridgeData, GNOSIS_CHAIN_ID)
    {
        if (
            (_bridgeData.sendingAssetId != DAI &&
                _bridgeData.sendingAssetId != USDS) ||
            (_swapData.length > 0 &&
                _bridgeData.sendingAssetId !=
                _swapData[_swapData.length - 1].receivingAssetId)
        ) {
            revert InvalidSendingToken();
        }
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via GnosisBridgeRouter
    /// @param _bridgeData the core information needed for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(GNOSIS_BRIDGE_ROUTER),
            _bridgeData.minAmount
        );

        GNOSIS_BRIDGE_ROUTER.relayTokens(
            _bridgeData.sendingAssetId,
            _bridgeData.receiver,
            _bridgeData.minAmount
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
