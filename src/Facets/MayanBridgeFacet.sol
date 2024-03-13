// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IMayanBridge } from "../Interfaces/IMayanBridge.sol";
import { UnsupportedChainId } from "../Errors/GenericErrors.sol";

/// @title MayanBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Mayan Bridge
/// @custom:version 1.0.0
contract MayanBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.mayan");
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    bytes32 internal constant MAYAN_AUCTION_ADDRESS =
        0x3383cb0c0c60fc12b717160b699a55db62c56baed78a0ff9ebed68e1b003d38c;
    uint16 internal constant MAYAN_CHAIN_ID = 1;

    IMayanBridge public immutable mayanBridge;

    /// Types ///

    struct Storage {
        mapping(uint256 => uint16) wormholeChainId;
    }

    struct Config {
        uint256 chainId;
        uint16 wormholeChainId;
    }

    /// @dev Optional bridge specific struct
    /// @param mayanAddr The address of the Mayan Bridge
    /// @param referrer The referrer address
    /// @param tokenOutAddr The address of the token to be received
    /// @param receiver The address of the receiver
    /// @param swapFee The swap fee
    /// @param redeemFee The redeem fee
    /// @param refundFee The refund fee
    /// @param transferDeadline The transfer deadline
    /// @param swapDeadline The swap deadline
    /// @param amountOutMin The minimum amount out
    /// @param destChainId The (wormhole) destination chain id
    /// @param unwrap Whether to unwrap the asset
    /// @param gasDrop The gas drop
    struct MayanBridgeData {
        bytes32 mayanAddr;
        bytes32 referrer;
        bytes32 tokenOutAddr;
        bytes32 receiver;
        uint64 swapFee;
        uint64 redeemFee;
        uint64 refundFee;
        uint256 transferDeadline;
        uint64 swapDeadline;
        uint64 amountOutMin;
        bool unwrap;
        uint64 gasDrop;
    }

    /// Events ///

    event MayanInitialized(Config[] configs);
    event MayanChainIdMapped(
        uint256 indexed lifiChainId,
        uint256 indexed wormholeChainId
    );
    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes32 receiver
    );

    /// Constructor ///

    /// @notice Constructor for the contract.
    constructor(IMayanBridge _mayanBridge) {
        mayanBridge = _mayanBridge;
    }

    /// Init ///

    /// @notice Initialize local variables for the Wormhole Facet
    /// @param configs Bridge configuration data
    function initMayanBridge(Config[] calldata configs) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage sm = getStorage();

        uint256 numConfigs = configs.length;
        for (uint256 i = 0; i < numConfigs; i++) {
            sm.wormholeChainId[configs[i].chainId] = configs[i]
                .wormholeChainId;
        }

        emit MayanInitialized(configs);
    }

    /// External Methods ///

    /// @notice Creates a mapping between a lifi chain id and a wormhole chain id
    /// @param _lifiChainId lifi chain id
    /// @param _wormholeChainId wormhole chain id
    function setMayanChainIdMapping(
        uint256 _lifiChainId,
        uint16 _wormholeChainId
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();
        sm.wormholeChainId[_lifiChainId] = _wormholeChainId;
        emit MayanChainIdMapped(_lifiChainId, _wormholeChainId);
    }

    /// @notice Bridges tokens via MayanBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanBridgeData Data specific to MayanBridge
    function startBridgeTokensViaMayanBridge(
        ILiFi.BridgeData memory _bridgeData,
        MayanBridgeData calldata _mayanBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        uint256 totalFees = _mayanBridgeData.swapFee +
            _mayanBridgeData.redeemFee +
            _mayanBridgeData.refundFee;

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _mayanBridgeData, totalFees);
    }

    /// @notice Performs a swap before bridging via MayanBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _mayanBridgeData Data specific to MayanBridge
    function swapAndStartBridgeTokensViaMayanBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MayanBridgeData calldata _mayanBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        uint256 totalFees = _mayanBridgeData.swapFee +
            _mayanBridgeData.redeemFee +
            _mayanBridgeData.refundFee;
        address assetId = _bridgeData.sendingAssetId;
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            LibAsset.isNativeAsset(assetId) ? 0 : totalFees
        );
        _startBridge(_bridgeData, _mayanBridgeData, totalFees);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via MayanBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanBridgeData Data specific to MayanBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MayanBridgeData calldata _mayanBridgeData,
        uint256 _totalFees
    ) internal {
        uint16 whDestChainId = getWormholeChainId(
            _bridgeData.destinationChainId
        );

        IMayanBridge.RelayerFees memory relayerFees = IMayanBridge
            .RelayerFees({
                swapFee: _mayanBridgeData.swapFee,
                redeemFee: _mayanBridgeData.redeemFee,
                refundFee: _mayanBridgeData.refundFee
            });

        IMayanBridge.Recepient memory recipient = IMayanBridge.Recepient({
            mayanAddr: _mayanBridgeData.mayanAddr,
            mayanChainId: MAYAN_CHAIN_ID,
            auctionAddr: MAYAN_AUCTION_ADDRESS,
            destAddr: _mayanBridgeData.receiver,
            destChainId: whDestChainId,
            referrer: _mayanBridgeData.referrer,
            refundAddr: _mayanBridgeData.receiver
        });

        IMayanBridge.Criteria memory criteria = IMayanBridge.Criteria({
            transferDeadline: _mayanBridgeData.transferDeadline,
            swapDeadline: _mayanBridgeData.swapDeadline,
            amountOutMin: _mayanBridgeData.amountOutMin,
            unwrap: _mayanBridgeData.unwrap,
            gasDrop: _mayanBridgeData.gasDrop,
            customPayload: ""
        });

        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(mayanBridge),
                _bridgeData.minAmount
            );

            mayanBridge.swap(
                relayerFees,
                recipient,
                _mayanBridgeData.tokenOutAddr,
                whDestChainId,
                criteria,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount - _totalFees
            );
        } else {
            mayanBridge.wrapAndSwapETH{ value: _bridgeData.minAmount }(
                relayerFees,
                recipient,
                _mayanBridgeData.tokenOutAddr,
                whDestChainId,
                criteria
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _mayanBridgeData.receiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Gets the wormhole chain id for a given lifi chain id
    /// @param _lifiChainId uint256 of the lifi chain ID
    /// @return uint16 of the wormhole chain id
    function getWormholeChainId(
        uint256 _lifiChainId
    ) private view returns (uint16) {
        Storage storage sm = getStorage();
        uint16 wormholeChainId = sm.wormholeChainId[_lifiChainId];
        if (wormholeChainId == 0) revert UnsupportedChainId(_lifiChainId);
        return wormholeChainId;
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
