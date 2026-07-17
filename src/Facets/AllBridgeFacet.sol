// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAllBridge } from "../Interfaces/IAllBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver, NotInitialized } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title AllBridgeFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through AllBridge
/// @dev The LI.FI chain ID to AllBridge chain ID mapping is held in diamond
///      storage and is owner-updatable (initAllBridge / setChainIdToAllBridgeChainId /
///      unsetChainIdToAllBridgeChainId), so new destinations can be added without a
///      facet redeploy. The facet must be initialized via initAllBridge before it can
///      bridge; an uninitialized (or unmapped) destination reverts UnsupportedAllBridgeChainId.
/// @dev This contract is not intended to custody user funds; any balances held are
///      incidental and transient during a bridge call and should not persist.
/// @custom:version 2.2.0
contract AllBridgeFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.allbridge");

    error UnsupportedAllBridgeChainId();

    /// @notice The contract address of the AllBridge router on the source chain.
    // solhint-disable-next-line immutable-vars-naming
    IAllBridge private immutable ALLBRIDGE;

    /// @notice The struct for the AllBridge data.
    /// @param recipient The address of the token receiver after bridging.
    /// @param fees The amount of token to pay the messenger and the bridge
    /// @param receiveToken The token to receive on the destination chain.
    /// @param nonce A random nonce to associate with the tx.
    /// @param messenger The messenger protocol enum
    /// @param payFeeWithSendingAsset Whether to pay the relayer fee with the sending asset or not
    struct AllBridgeData {
        bytes32 recipient;
        uint256 fees;
        bytes32 receiveToken;
        uint256 nonce;
        IAllBridge.MessengerProtocol messenger;
        bool payFeeWithSendingAsset;
    }

    /// @notice Maps a LI.FI chain ID to the corresponding AllBridge chain ID.
    /// @param chainId LI.FI internal chain ID
    /// @param allBridgeChainId AllBridge internal chain ID
    struct ChainIdConfig {
        uint256 chainId;
        uint256 allBridgeChainId;
    }

    struct Storage {
        // Maps a LI.FI chain ID to its AllBridge chain ID. AllBridge chain IDs start at 1
        // (Ethereum), so a stored 0 unambiguously means "unmapped" and no offset is needed.
        mapping(uint256 => uint256) allBridgeChainIds;
        bool chainMappingsInitialized;
    }

    /// Events ///

    event AllBridgeChainMappingsInitialized(ChainIdConfig[] chainIdConfigs);

    event ChainIdToAllBridgeChainIdSet(
        uint256 indexed chainId,
        uint256 allBridgeChainId
    );

    event ChainIdToAllBridgeChainIdUnset(uint256 indexed chainId);

    /// @notice Initializes the AllBridge contract
    /// @param _allBridge The address of the AllBridge contract
    constructor(IAllBridge _allBridge) {
        if (address(_allBridge) == address(0)) revert InvalidConfig();

        ALLBRIDGE = _allBridge;
    }

    /// @notice Initializes the LI.FI chain ID to AllBridge chain ID mappings
    /// @param chainIdConfigs Chain ID configuration data
    /// @dev Re-initialization overwrites the provided mappings and leaves the rest untouched.
    /// @dev A zero chainId or allBridgeChainId is rejected: 0 is the reserved
    ///      "unmapped" sentinel (see Storage), so it must never be stored.
    /// https://docs-core.allbridge.io/product/how-does-allbridge-core-work/allbridge-core-contracts
    function initAllBridge(ChainIdConfig[] calldata chainIdConfigs) external {
        if (chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();

        Storage storage sm = getStorage();

        for (uint256 i = 0; i < chainIdConfigs.length; ) {
            uint256 chainId = chainIdConfigs[i].chainId;
            uint256 allBridgeChainId = chainIdConfigs[i].allBridgeChainId;

            if (chainId == 0 || allBridgeChainId == 0) revert InvalidConfig();

            sm.allBridgeChainIds[chainId] = allBridgeChainId;

            unchecked {
                ++i;
            }
        }

        sm.chainMappingsInitialized = true;
        emit AllBridgeChainMappingsInitialized(chainIdConfigs);
    }

    /// @notice Sets the AllBridge chain ID for one or more LI.FI chain IDs
    /// @param chainIdConfigs Chain ID configuration data
    /// @dev A zero chainId or allBridgeChainId is rejected; use
    ///      unsetChainIdToAllBridgeChainId to remove a mapping.
    function setChainIdToAllBridgeChainId(
        ChainIdConfig[] calldata chainIdConfigs
    ) external {
        if (chainIdConfigs.length == 0) revert InvalidConfig();
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.chainMappingsInitialized) {
            revert NotInitialized();
        }

        for (uint256 i = 0; i < chainIdConfigs.length; ) {
            uint256 chainId = chainIdConfigs[i].chainId;
            uint256 allBridgeChainId = chainIdConfigs[i].allBridgeChainId;

            if (chainId == 0 || allBridgeChainId == 0) revert InvalidConfig();

            sm.allBridgeChainIds[chainId] = allBridgeChainId;
            emit ChainIdToAllBridgeChainIdSet(chainId, allBridgeChainId);

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Removes the AllBridge chain ID mapping for a given LI.FI chain ID
    /// @param _chainId LI.FI chain ID
    function unsetChainIdToAllBridgeChainId(uint256 _chainId) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage sm = getStorage();

        if (!sm.chainMappingsInitialized) {
            revert NotInitialized();
        }

        delete sm.allBridgeChainIds[_chainId];
        emit ChainIdToAllBridgeChainIdUnset(_chainId);
    }

    /// @notice Gets the AllBridge chain ID for a given LI.FI chain ID
    /// @param _chainId LI.FI chain ID
    /// @return The corresponding AllBridge chain ID
    function getChainIdToAllBridgeChainId(
        uint256 _chainId
    ) external view returns (uint256) {
        return _getAllBridgeChainId(_chainId);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    function startBridgeTokensViaAllBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
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
        _startBridge(_bridgeData, _allBridgeData);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    /// @param _swapData The swap data struct
    /// @param _allBridgeData The AllBridge data struct
    function swapAndStartBridgeTokensViaAllBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AllBridgeData calldata _allBridgeData
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
        _startBridge(_bridgeData, _allBridgeData);
    }

    /// @notice Bridge tokens to another chain via AllBridge
    /// @param _bridgeData The bridge data struct
    /// @param _allBridgeData The allBridge data struct for AllBridge specicific data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AllBridgeData calldata _allBridgeData
    ) internal {
        // we do not validate _allBridgeData.fees here due to gas optimization reasons
        // our backend ensures that the fees are correct

        // get allbridge (custom) destination chain id
        uint256 destinationChainId = _getAllBridgeChainId(
            _bridgeData.destinationChainId
        );

        // validate receiver address
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // destination chain is non-EVM
            // make sure it's non-zero (we cannot validate further)
            if (_allBridgeData.recipient == bytes32(0))
                revert InvalidNonEVMReceiver();

            // emit event for non-EVM chain
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                destinationChainId,
                _allBridgeData.recipient
            );
        } else {
            // destination chain is EVM
            // make sure that bridgeData and allBridgeData receiver addresses match
            if (
                _bridgeData.receiver !=
                address(uint160(uint256(_allBridgeData.recipient)))
            ) revert InvalidReceiver();
        }

        // set max approval to allBridge, if current allowance is insufficient
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(ALLBRIDGE),
            _bridgeData.minAmount
        );

        // check if bridge fee should be paid with sending or native asset
        if (_allBridgeData.payFeeWithSendingAsset) {
            // pay fee with sending asset
            ALLBRIDGE.swapAndBridge(
                bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                _bridgeData.minAmount,
                _allBridgeData.recipient,
                destinationChainId,
                _allBridgeData.receiveToken,
                _allBridgeData.nonce,
                _allBridgeData.messenger,
                _allBridgeData.fees
            );
        } else {
            // pay fee with native asset
            ALLBRIDGE.swapAndBridge{ value: _allBridgeData.fees }(
                bytes32(uint256(uint160(_bridgeData.sendingAssetId))),
                _bridgeData.minAmount,
                _allBridgeData.recipient,
                destinationChainId,
                _allBridgeData.receiveToken,
                _allBridgeData.nonce,
                _allBridgeData.messenger,
                0
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Converts LI.FI internal chain IDs to AllBridge chain IDs
    // https://docs-core.allbridge.io/product/how-does-allbridge-core-work/allbridge-core-contracts
    /// @param _destinationChainId The LI.FI chain ID to convert
    /// @return The corresponding AllBridge chain ID
    /// @dev Reverts if the destination chain is not mapped
    function _getAllBridgeChainId(
        uint256 _destinationChainId
    ) internal view returns (uint256) {
        uint256 allBridgeChainId = getStorage().allBridgeChainIds[
            _destinationChainId
        ];
        if (allBridgeChainId == 0) revert UnsupportedAllBridgeChainId();

        return allBridgeChainId;
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
