// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IMayan } from "../Interfaces/IMayan.sol";
import { UnsupportedChainId } from "../Errors/GenericErrors.sol";
import { console } from "hardhat/console.sol";

/// @title Mayan Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Mayan Bridge
/// @custom:version 1.0.0
contract MayanFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.mayan");
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    IMayan public immutable mayan;

    /// @dev Mayan specific bridge data
    /// @param nonEVMReceiver The address of the non-EVM receiver if applicable
    /// @param mayanProtocol The address of the Mayan protocol final contract
    /// @param protocolData The protocol data for the Mayan protocol
    struct MayanData {
        bytes32 nonEVMReceiver;
        address mayanProtocol;
        bytes protocolData;
    }

    /// Errors ///
    error InvalidReceiver(address expected, address actual);
    error InvalidNonEVMReceiver(bytes32 expected, bytes32 actual);

    /// Events ///

    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes32 receiver
    );

    /// Constructor ///

    /// @notice Constructor for the contract.
    constructor(IMayan _mayan) {
        mayan = _mayan;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Mayan
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanData Data specific to Mayan
    function startBridgeTokensViaMayan(
        ILiFi.BridgeData memory _bridgeData,
        MayanData calldata _mayanData
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
        _startBridge(_bridgeData, _mayanData);
    }

    /// @notice Performs a swap before bridging via Mayan
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _mayanData Data specific to Mayan
    function swapAndStartBridgeTokensViaMayan(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MayanData calldata _mayanData
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
        _startBridge(_bridgeData, _mayanData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Mayan
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanData Data specific to Mayan
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MayanData calldata _mayanData
    ) internal {
        // Validate receiver address
        bytes memory protocolData = _mayanData.protocolData;
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            if (_mayanData.nonEVMReceiver == bytes32(0)) {
                revert InvalidNonEVMReceiver(
                    _mayanData.nonEVMReceiver,
                    bytes32(0)
                );
            }
            bytes32 receiver = _parseReceiver(_mayanData.protocolData);
            if (_mayanData.nonEVMReceiver != receiver) {
                revert InvalidNonEVMReceiver(
                    _mayanData.nonEVMReceiver,
                    receiver
                );
            }
        } else {
            address receiver = address(
                uint160(uint256(_parseReceiver(_mayanData.protocolData)))
            );
            if (_bridgeData.receiver != receiver) {
                revert InvalidReceiver(_bridgeData.receiver, receiver);
            }
        }

        IMayan.PermitParams memory emptyPermitParams;

        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(mayan),
                _bridgeData.minAmount
            );

            mayan.forwardERC20(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                emptyPermitParams,
                _mayanData.mayanProtocol,
                _mayanData.protocolData
            );
        } else {
            mayan.forwardEth{ value: _bridgeData.minAmount }(
                _mayanData.mayanProtocol,
                _mayanData.protocolData
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _mayanData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    // @dev Parses the receiver address from the protocol data
    // @param protocolData The protocol data for the Mayan protocol
    // @return receiver The receiver address
    function _parseReceiver(
        bytes memory protocolData
    ) internal pure returns (bytes32 receiver) {
        bytes4 selector;
        assembly {
            // Load the selector from the protocol data
            selector := mload(add(protocolData, 0x20))
            // Shift the selector to the right by 224 bits to match shape of literal in switch statement
            let shiftedSelector := shr(224, selector)
            switch shiftedSelector
            // Note: [*bytes32*] = location of receiver address
            case 0x94454a5d {
                // 0x94454a5d bridgeWithFee(address,uint256,uint64,uint64,[*bytes32*],(uint32,bytes32,bytes32))
                receiver := mload(add(protocolData, 0xa4)) // MayanCircle::bridgeWithFee()
            }
            case 0x32ad465f {
                // 0x32ad465f bridgeWithLockedFee(address,uint256,uint64,uint256,(uint32,[*bytes32*],bytes32))
                receiver := mload(add(protocolData, 0xc4)) // MayanCircle::bridgeWithLockedFee()
            }
            case 0xafd9b706 {
                // 0xafd9b706 createOrder((address,uint256,uint64,[*bytes32*],uint16,bytes32,uint64,uint64,uint64,bytes32,uint8),(uint32,bytes32,bytes32))
                receiver := mload(add(protocolData, 0x84)) // MayanCircle::createOrder()
            }
            case 0x6111ad25 {
                // 0x6111ad25 swap((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes),address,uint256)
                receiver := mload(add(protocolData, 0xe4)) // MayanSwap::swap()
            }
            case 0x1eb1cff0 {
                // 0x1eb1cff0 wrapAndSwapETH((uint64,uint64,uint64),(bytes32,uint16,bytes32,[*bytes32*],uint16,bytes32,bytes32),bytes32,uint16,(uint256,uint64,uint64,bool,uint64,bytes))
                receiver := mload(add(protocolData, 0xe4)) // MayanSwap::wrapAndSwapETH()
            }
            case 0xb866e173 {
                // 0xb866e173 createOrderWithEth((bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
                receiver := mload(add(protocolData, 0x104)) // MayanSwift::createOrderWithEth()
            }
            case 0x8e8d142b {
                // 0x8e8d142b createOrderWithToken(address,uint256,(bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,[*bytes32*],uint16,bytes32,uint8,uint8,bytes32))
                receiver := mload(add(protocolData, 0x144)) // MayanSwift::createOrderWithToken()
            }
            default {
                receiver := 0x0
            }
        }
    }
}
