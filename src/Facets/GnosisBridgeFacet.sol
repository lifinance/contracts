// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IXDaiBridge } from "../Interfaces/IXDaiBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidConfig } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";

/// @title GnosisBridgeFacet Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through XDaiBridge
contract GnosisBridgeFacet is ILiFi, Swapper, ReentrancyGuard {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.gnosis");
    struct Storage {
        address xDaiBridge;
        address token;
        uint64 dstChainId;
    }

    /// Types ///

    struct GnosisBridgeData {
        address receiver;
        uint256 amount;
    }

    /// Errors ///

    error InvalidDstChainId();
    error InvalidSendingToken();

    /// Events ///

    /// @notice Emitted when facet is initialized
    /// @param xDaiBridge address of the canonical XDaiBridge contract
    /// @param token address of the token on source network
    /// @param dstChainId chainId of destination network
    event GnosisBridgeInitialized(address xDaiBridge, address token, uint256 dstChainId);

    /// Init ///

    /// @notice Initializes local variables for the XDaiBridge facet
    /// @param xDaiBridge address of the XDaiBridge contract
    /// @param token address of the token on source network
    /// @param dstChainId chainId of destination network
    function initGnosisBridge(
        address xDaiBridge,
        address token,
        uint64 dstChainId
    ) external {
        LibDiamond.enforceIsContractOwner();

        if (xDaiBridge == address(0)) {
            revert InvalidConfig();
        }

        Storage storage s = getStorage();
        s.xDaiBridge = xDaiBridge;
        s.token = token;
        s.dstChainId = dstChainId;

        emit GnosisBridgeInitialized(xDaiBridge, token, dstChainId);
    }

    /// External Methods ///

    /// @notice Bridges tokens via XDaiBridge
    /// @param lifiData data used purely for tracking and analytics
    /// @param gnosisBridgeData data specific to bridge
    function startBridgeTokensViaXDaiBridge(LiFiData calldata lifiData, GnosisBridgeData calldata gnosisBridgeData)
        external
        payable
        nonReentrant
    {
        Storage storage s = getStorage();

        if (lifiData.destinationChainId != s.dstChainId) {
            revert InvalidDstChainId();
        }
        if (lifiData.sendingAssetId != s.token) {
            revert InvalidSendingToken();
        }
        if (gnosisBridgeData.amount == 0) {
            revert InvalidAmount();
        }

        LibAsset.depositAsset(s.token, gnosisBridgeData.amount);

        _startBridge(gnosisBridgeData);

        emit LiFiTransferStarted(
            lifiData.transactionId,
            "gnosis",
            "",
            lifiData.integrator,
            lifiData.referrer,
            lifiData.sendingAssetId,
            lifiData.receivingAssetId,
            gnosisBridgeData.receiver,
            gnosisBridgeData.amount,
            lifiData.destinationChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via XDaiBridge
    /// @param lifiData data used purely for tracking and analytics
    /// @param swapData an array of swap related data for performing swaps before bridging
    /// @param gnosisBridgeData data specific to bridge
    function swapAndStartBridgeTokensViaXDaiBridge(
        LiFiData calldata lifiData,
        LibSwap.SwapData[] calldata swapData,
        GnosisBridgeData memory gnosisBridgeData
    ) external payable nonReentrant {
        Storage storage s = getStorage();

        if (lifiData.destinationChainId != s.dstChainId) {
            revert InvalidDstChainId();
        }
        if (lifiData.sendingAssetId != s.token) {
            revert InvalidSendingToken();
        }

        gnosisBridgeData.amount = _executeAndCheckSwaps(lifiData, swapData);

        if (gnosisBridgeData.amount == 0) {
            revert InvalidAmount();
        }

        _startBridge(gnosisBridgeData);

        emit LiFiTransferStarted(
            lifiData.transactionId,
            "gnosis",
            "",
            lifiData.integrator,
            lifiData.referrer,
            swapData[0].sendingAssetId,
            lifiData.receivingAssetId,
            gnosisBridgeData.receiver,
            swapData[0].fromAmount,
            lifiData.destinationChainId,
            true,
            false
        );
    }

    /// Private Methods ///

    /// @dev Conatains the business logic for the bridge via XDaiBridge
    /// @param gnosisBridgeData data specific to bridge
    function _startBridge(GnosisBridgeData memory gnosisBridgeData) private {
        Storage storage s = getStorage();

        LibAsset.maxApproveERC20(IERC20(s.token), s.xDaiBridge, gnosisBridgeData.amount);
        IXDaiBridge(s.xDaiBridge).relayTokens(gnosisBridgeData.receiver, gnosisBridgeData.amount);
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
