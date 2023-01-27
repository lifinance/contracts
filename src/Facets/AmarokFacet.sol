// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IConnextHandler } from "../Interfaces/IConnextHandler.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidReceiver, InvalidAmount, InformationMismatch } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibMappings } from "../Libraries/LibMappings.sol";

/// @title Amarok Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Connext Amarok
contract AmarokFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the connext handler on the source chain.
    IConnextHandler private immutable connextHandler;

    /// @notice The domain of source chain.
    uint32 private immutable srcChainDomain;

    /// Errors ///

    error UnknownAmarokDomain(uint32 domain);

    /// Events ///

    event AmarokDomainSet(uint256 indexed chainId, uint32 indexed domain);

    /// Types ///

    /// @param callData The data to execute on the receiving chain. If no crosschain call is needed, then leave empty.
    /// @param callTo The address of the contract on dest chain that will receive bridged funds and execute data
    /// @param relayerFee The amount of relayer fee the tx called xcall with
    /// @param slippageTol Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    /// @param delegate Max bps of original due to slippage (i.e. would be 9995 to tolerate .05% slippage)
    struct AmarokData {
        bytes callData;
        address callTo;
        uint256 relayerFee;
        uint256 slippageTol;
        address delegate;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _connextHandler The contract address of the connext handler on the source chain.
    /// @param _srcChainDomain The domain of source chain.
    constructor(IConnextHandler _connextHandler, uint32 _srcChainDomain) {
        connextHandler = _connextHandler;
        srcChainDomain = _srcChainDomain;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Amarok
    /// @param _bridgeData Data containing core information for bridging
    /// @param _amarokData Data specific to bridge
    function startBridgeTokensViaAmarok(
        BridgeData calldata _bridgeData,
        AmarokData calldata _amarokData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        if (
            hasDestinationCall(_amarokData) != _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _amarokData);
    }

    /// @notice Performs a swap before bridging via Amarok
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _amarokData Data specific to bridge
    function swapAndStartBridgeTokensViaAmarok(
        BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AmarokData calldata _amarokData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        if (
            hasDestinationCall(_amarokData) != _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _amarokData);
    }

    function setAmarokDomain(uint256 _chainId, uint32 _domain) external {
        LibDiamond.enforceIsContractOwner();
        LibMappings.AmarokMappings storage sm = LibMappings
            .getAmarokMappings();
        sm.amarokDomain[_chainId] = _domain;
        emit AmarokDomainSet(_chainId, _domain);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Amarok
    /// @param _bridgeData Data used purely for tracking and analytics
    /// @param _amarokData Data specific to Amarok
    function _startBridge(
        BridgeData memory _bridgeData,
        AmarokData calldata _amarokData
    ) private {
        // get Amarok-specific domain for destination chain
        uint32 dstChainDomain = getAmarokDomain(
            _bridgeData.destinationChainId
        );

        // give max approval for token to Amarok bridge, if not already
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(connextHandler),
            _bridgeData.minAmount
        );

        // initiate bridge transaction
        connextHandler.xcall{ value: _amarokData.relayerFee }(
            dstChainDomain,
            _bridgeData.receiver,
            _bridgeData.sendingAssetId,
            _bridgeData.receiver,
            _bridgeData.minAmount,
            _amarokData.slippageTol,
            _amarokData.callData
        );

        emit LiFiTransferStarted(_bridgeData);
    }

    function getAmarokDomain(uint256 _chainId) private view returns (uint32) {
        LibMappings.AmarokMappings storage sm = LibMappings
            .getAmarokMappings();
        uint32 domain = sm.amarokDomain[_chainId];
        if (domain == 0) {
            revert UnknownAmarokDomain(domain);
        }
        return domain;
    }

    function hasDestinationCall(AmarokData calldata _amarokData)
        private
        pure
        returns (bool)
    {
        return _amarokData.callData.length > 0;
    }
}
