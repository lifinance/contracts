// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRootChainManager } from "../Interfaces/IRootChainManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount } from "../Errors/GenericErrors.sol";
import "../Helpers/Swapper.sol";

/// @title Polygon Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Polygon Bridge
contract PolygonBridgeFacet is ILiFi, Swapper, ReentrancyGuard {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.polygon.bridge");
    struct Storage {
        address rootChainManager;
        address erc20Predicate;
    }

    /// Types ///

    struct BridgeData {
        address assetId;
        uint256 amount;
        address receiver;
    }

    /// Errors ///

    error InvalidConfig();
    error InvalidReceiver();

    /// Events ///

    /// @notice Emitted when facet is initialized.
    /// @param rootChainManager address of the canonical RootChainManager contract
    /// @param erc20Predicate address of the canonical ERC20Predicate contract
    event PolygonBridgeInitialized(address rootChainManager, address erc20Predicate);

    /// Init ///

    /// @notice Initializes local variables for the Polygon Bridge facet
    /// @param _rootChainManager address of the canonical RootChainManager contract
    /// @param _erc20Predicate address of the canonical ERC20Predicate contract
    function initPolygonBridge(address _rootChainManager, address _erc20Predicate) external {
        LibDiamond.enforceIsContractOwner();

        if (_rootChainManager == address(0) || _erc20Predicate == address(0)) {
            revert InvalidConfig();
        }

        Storage storage s = getStorage();
        s.rootChainManager = _rootChainManager;
        s.erc20Predicate = _erc20Predicate;

        emit PolygonBridgeInitialized(_rootChainManager, _erc20Predicate);
    }

    /// External Methods ///

    /// @notice Bridges tokens via Polygon Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data for asset id and amount
    function startBridgeTokensViaPolygonBridge(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)
        external
        payable
        nonReentrant
    {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        if (_bridgeData.amount == 0) {
            revert InvalidAmount();
        }

        if (!LibAsset.isNativeAsset(_bridgeData.assetId)) {
            uint256 _fromTokenBalance = LibAsset.getOwnBalance(_bridgeData.assetId);
            LibAsset.transferFromERC20(_bridgeData.assetId, msg.sender, address(this), _bridgeData.amount);

            if (LibAsset.getOwnBalance(_bridgeData.assetId) - _fromTokenBalance != _bridgeData.amount) {
                revert InvalidAmount();
            }
        }

        _startBridge(_lifiData, _bridgeData.assetId, _bridgeData.amount, _bridgeData.receiver, false);
    }

    /// @notice Performs a swap before bridging via Polygon Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data for asset id and amount
    function swapAndStartBridgeTokensViaPolygonBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData calldata _bridgeData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }

        uint256 amount = _executeAndCheckSwaps(_lifiData, _swapData);

        if (amount == 0) {
            revert InvalidAmount();
        }

        _startBridge(_lifiData, _bridgeData.assetId, amount, _bridgeData.receiver, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Polygon Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _assetId Sending token address
    /// @param _amount Amount to bridge
    /// @param _receiver Receiver address
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData memory _lifiData,
        address _assetId,
        uint256 _amount,
        address _receiver,
        bool _hasSourceSwap
    ) private {
        Storage storage s = getStorage();
        IRootChainManager rootChainManager = IRootChainManager(s.rootChainManager);
        address childToken;

        if (LibAsset.isNativeAsset(_assetId)) {
            rootChainManager.depositEtherFor{ value: _amount }(_receiver);
        } else {
            childToken = rootChainManager.rootToChildToken(_lifiData.sendingAssetId);

            LibAsset.maxApproveERC20(IERC20(_assetId), s.erc20Predicate, _amount);

            bytes memory depositData = abi.encode(_amount);
            rootChainManager.depositFor(_receiver, _assetId, depositData);
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "polygon",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            childToken,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            _hasSourceSwap,
            false
        );
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
