// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IWormholeRouter } from "../Interfaces/IWormholeRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, CannotBridgeToSameNetwork, InvalidConfig, UnsupportedChainId } from "../Errors/GenericErrors.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Wormhole Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Wormhole
contract WormholeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.wormhole");

    /// Events ///

    event WormholeChainIdMapped(uint256 indexed lifiChainId, uint256 indexed wormholeChainId);

    /// Types ///

    /// @param wormholeRouter The contract address of the Wormhole router.
    /// @param token The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param recipient The address of the token recipient after bridging.
    /// @param toChainId The chainId of the chain to bridge to.
    /// @param arbiterFee The amount of token to pay a relayer (can be zero if no relayer is used).
    /// @param nonce A random nonce to associate with the tx.
    struct WormholeData {
        address wormholeRouter;
        uint256 arbiterFee;
        uint32 nonce;
    }

    struct Storage {
        // Mapping between lifi chain id and wormhole chain id
        mapping(uint256 => uint16) wormholeChainId;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Wormhole
    /// @param _bridgeData the core information needed for bridging
    /// @param _wormholeData data specific to Wormhole
    function startBridgeTokensViaWormhole(ILiFi.BridgeData memory _bridgeData, WormholeData calldata _wormholeData)
        external
        payable
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
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
    ) external payable containsSourceSwaps(_bridgeData) validateBridgeData(_bridgeData) nonReentrant {
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
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
    function setWormholeChainId(uint256 _lifiChainId, uint16 _wormholeChainId) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();
        s.wormholeChainId[_lifiChainId] = _wormholeChainId;
        emit WormholeChainIdMapped(_lifiChainId, _wormholeChainId);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Wormhole
    /// @param _bridgeData the core information needed for bridging
    /// @param _wormholeData data specific to Wormhole
    function _startBridge(ILiFi.BridgeData memory _bridgeData, WormholeData calldata _wormholeData) private {
        Storage storage s = getStorage();
        uint16 toWormholeChainId = s.wormholeChainId[_bridgeData.destinationChainId];
        uint16 fromWormholeChainId = s.wormholeChainId[block.chainid];

        {
            if (block.chainid == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();
            if (toWormholeChainId == 0) revert UnsupportedChainId(_bridgeData.destinationChainId);
            if (fromWormholeChainId == 0) revert UnsupportedChainId(block.chainid);
            if (fromWormholeChainId == toWormholeChainId) revert CannotBridgeToSameNetwork();
        }

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            _wormholeData.wormholeRouter,
            _bridgeData.minAmount
        );

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            IWormholeRouter(_wormholeData.wormholeRouter).wrapAndTransferETH{ value: _bridgeData.minAmount }(
                toWormholeChainId,
                bytes32(uint256(uint160(_bridgeData.receiver))),
                _wormholeData.arbiterFee,
                _wormholeData.nonce
            );
        } else {
            IWormholeRouter(_wormholeData.wormholeRouter).transferTokens(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                toWormholeChainId,
                bytes32(uint256(uint160(_bridgeData.receiver))),
                _wormholeData.arbiterFee,
                _wormholeData.nonce
            );
        }
        emit LiFiTransferStarted(_bridgeData);
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
