// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IWormholeRouter } from "../Interfaces/IWormholeRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { UnsupportedChainId, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibMappings } from "../Libraries/LibMappings.sol";

/// @title Wormhole Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Wormhole
contract WormholeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    /// @notice The contract address of the wormhole router on the source chain.
    IWormholeRouter private immutable router;

    /// Types ///

    struct Config {
        uint256 chainId;
        uint16 wormholeChainId;
    }

    /// @param receiver The address of the token receiver after bridging.
    /// @param arbiterFee The amount of token to pay a relayer (can be zero if no relayer is used).
    /// @param nonce A random nonce to associate with the tx.
    struct WormholeData {
        bytes32 receiver;
        uint256 arbiterFee;
        uint32 nonce;
    }

    /// Events ///

    event WormholeInitialized(Config[] configs);
    event WormholeChainIdMapped(
        uint256 indexed lifiChainId,
        uint256 indexed wormholeChainId
    );
    event WormholeChainIdsMapped(Config[] configs);
    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed wormholeChainId,
        bytes32 receiver
    );

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the wormhole router on the source chain.
    constructor(IWormholeRouter _router) {
        router = _router;
    }

    /// Init ///

    /// @notice Initialize local variables for the Wormhole Facet
    /// @param configs Bridge configuration data
    function initWormhole(Config[] calldata configs) external {
        LibDiamond.enforceIsContractOwner();

        LibMappings.WormholeMappings storage sm = LibMappings
            .getWormholeMappings();

        if (sm.initialized) {
            revert AlreadyInitialized();
        }

        uint256 numConfigs = configs.length;
        for (uint256 i = 0; i < numConfigs; i++) {
            sm.wormholeChainId[configs[i].chainId] = configs[i]
                .wormholeChainId;
        }

        sm.initialized = true;

        emit WormholeInitialized(configs);
    }

    /// External Methods ///

    /// @notice Bridges tokens via Wormhole
    /// @param _bridgeData the core information needed for bridging
    /// @param _wormholeData data specific to Wormhole
    function startBridgeTokensViaWormhole(
        ILiFi.BridgeData memory _bridgeData,
        WormholeData calldata _wormholeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _wormholeData);
    }

    /// @notice Performs a swap before bridging via Wormhole
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _wormholeData data specific to Wormhole
    function swapAndStartBridgeTokensViaWormhole(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        WormholeData calldata _wormholeData
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
        _startBridge(_bridgeData, _wormholeData);
    }

    /// @notice Creates a mapping between a lifi chain id and a wormhole chain id
    /// @param _lifiChainId lifi chain id
    /// @param _wormholeChainId wormhole chain id
    function setWormholeChainId(uint256 _lifiChainId, uint16 _wormholeChainId)
        external
    {
        LibDiamond.enforceIsContractOwner();
        LibMappings.WormholeMappings storage sm = LibMappings
            .getWormholeMappings();
        sm.wormholeChainId[_lifiChainId] = _wormholeChainId;
        emit WormholeChainIdMapped(_lifiChainId, _wormholeChainId);
    }

    /// @notice Creates mappings between chain ids and wormhole chain ids
    /// @param configs Bridge configuration data
    function setWormholeChainIds(Config[] calldata configs) external {
        LibDiamond.enforceIsContractOwner();

        LibMappings.WormholeMappings storage sm = LibMappings
            .getWormholeMappings();

        if (!sm.initialized) {
            revert NotInitialized();
        }

        uint256 numConfigs = configs.length;
        for (uint256 i = 0; i < numConfigs; i++) {
            sm.wormholeChainId[configs[i].chainId] = configs[i]
                .wormholeChainId;
        }

        emit WormholeChainIdsMapped(configs);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Wormhole
    /// @param _bridgeData the core information needed for bridging
    /// @param _wormholeData data specific to Wormhole
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        WormholeData calldata _wormholeData
    ) private {
        uint16 toWormholeChainId = getWormholeChainId(
            _bridgeData.destinationChainId
        );
        uint16 fromWormholeChainId = getWormholeChainId(block.chainid);

        {
            if (toWormholeChainId == 0)
                revert UnsupportedChainId(_bridgeData.destinationChainId);
            if (fromWormholeChainId == 0)
                revert UnsupportedChainId(block.chainid);
        }

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(router),
            _bridgeData.minAmount
        );

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            router.wrapAndTransferETH{ value: _bridgeData.minAmount }(
                toWormholeChainId,
                _wormholeData.receiver,
                _wormholeData.arbiterFee,
                _wormholeData.nonce
            );
        } else {
            router.transferTokens(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                toWormholeChainId,
                _wormholeData.receiver,
                _wormholeData.arbiterFee,
                _wormholeData.nonce
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                toWormholeChainId,
                _wormholeData.receiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Gets the wormhole chain id for a given lifi chain id
    /// @param _lifiChainId uint256 of the lifi chain ID
    /// @return uint16 of the wormhole chain id
    function getWormholeChainId(uint256 _lifiChainId)
        private
        view
        returns (uint16)
    {
        LibMappings.WormholeMappings storage sm = LibMappings
            .getWormholeMappings();
        uint16 wormholeChainId = sm.wormholeChainId[_lifiChainId];
        if (wormholeChainId == 0) revert UnsupportedChainId(_lifiChainId);
        return wormholeChainId;
    }
}
