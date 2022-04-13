// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidBridgeConfigLength, CannotBridgeToSameNetwork, NativeValueWithERC } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";

/**
 * @title Hop Facet
 * @author LI.FI (https://li.fi)
 * @notice Provides functionality for bridging through Hop
 */
contract HopFacet is ILiFi, Swapper, ReentrancyGuard {
    /* ========== Storage ========== */

    bytes32 internal constant NAMESPACE = hex"6d21be7f069eba22e6227bbf0972cf4a3ee2f0ce81ad8bd8004228e83b4830b8"; //keccak256("com.lifi.facets.hop");
    struct Storage {
        mapping(string => IHopBridge.BridgeConfig) hopBridges;
        uint256 hopChainId;
    }

    /* ========== Types ========== */

    struct HopData {
        string asset;
        address recipient;
        uint256 chainId;
        uint256 amount;
        uint256 bonderFee;
        uint256 amountOutMin;
        uint256 deadline;
        uint256 destinationAmountOutMin;
        uint256 destinationDeadline;
    }

    /* ========== Errors ========== */

    error InvalidConfig();

    /* ========== Init ========== */

    function initHop(
        string[] calldata _tokens,
        IHopBridge.BridgeConfig[] calldata _bridgeConfigs,
        uint256 _chainId
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        uint256 length = _tokens.length;

        if (_bridgeConfigs.length != length) revert InvalidBridgeConfigLength();

        for (uint256 i = 0; i < length; i++) {
            if (_bridgeConfigs[i].bridge == address(0)) revert InvalidConfig();
            s.hopBridges[_tokens[i]] = _bridgeConfigs[i];
        }
        s.hopChainId = _chainId;
    }

    /* ========== Public Bridge Functions ========== */

    /**
     * @notice Bridges tokens via Hop Protocol
     * @param _lifiData data used purely for tracking and analytics
     * @param _hopData data specific to Hop Protocol
     */
    function startBridgeTokensViaHop(LiFiData calldata _lifiData, HopData calldata _hopData)
        external
        payable
        nonReentrant
    {
        address sendingAssetId = _bridge(_hopData.asset).token;
        LibAsset.depositAsset(sendingAssetId, _hopData.amount);
        _startBridge(_hopData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            _lifiData.integrator,
            _lifiData.referrer,
            sendingAssetId,
            _lifiData.receivingAssetId,
            _hopData.recipient,
            _hopData.amount,
            _hopData.chainId,
            block.timestamp
        );
    }

    /**
     * @notice Performs a swap before bridging via Hop Protocol
     * @param _lifiData data used purely for tracking and analytics
     * @param _swapData an array of swap related data for performing swaps before bridging
     * @param _hopData data specific to Hop Protocol
     */
    function swapAndStartBridgeTokensViaHop(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        HopData memory _hopData
    ) external payable nonReentrant {
        if (!LibAsset.isNativeAsset(address(_lifiData.sendingAssetId)) && msg.value != 0) revert NativeValueWithERC();
        _hopData.amount = _executeAndCheckSwaps(_lifiData, _swapData);
        _startBridge(_hopData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _hopData.recipient,
            _swapData[0].fromAmount,
            _hopData.chainId,
            block.timestamp
        );
    }

    /* ========== private Functions ========== */

    /**
     * @dev Conatains the business logic for the bridge via Hop Protocol
     * @param _hopData data specific to Hop Protocol
     */
    function _startBridge(HopData memory _hopData) private {
        Storage storage s = getStorage();
        IHopBridge.BridgeConfig storage hopBridgeConfig = s.hopBridges[_hopData.asset];

        address sendingAssetId = hopBridgeConfig.token;

        address bridge;
        if (s.hopChainId == 1) {
            bridge = hopBridgeConfig.bridge;
        } else {
            bridge = hopBridgeConfig.ammWrapper;
        }

        // Do HOP stuff
        if (s.hopChainId == _hopData.chainId) revert CannotBridgeToSameNetwork();

        // Give Hop approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(sendingAssetId), bridge, _hopData.amount);

        uint256 value = LibAsset.isNativeAsset(address(sendingAssetId)) ? _hopData.amount : 0;

        if (s.hopChainId == 1) {
            // Ethereum L1
            IHopBridge(bridge).sendToL2{ value: value }(
                _hopData.chainId,
                _hopData.recipient,
                _hopData.amount,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline,
                address(0),
                0
            );
        } else {
            // L2
            // solhint-disable-next-line check-send-result
            IHopBridge(bridge).swapAndSend{ value: value }(
                _hopData.chainId,
                _hopData.recipient,
                _hopData.amount,
                _hopData.bonderFee,
                _hopData.amountOutMin,
                _hopData.deadline,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline
            );
        }
    }

    function _bridge(string memory _asset) private view returns (IHopBridge.BridgeConfig memory) {
        Storage storage s = getStorage();
        return s.hopBridges[_asset];
    }

    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
