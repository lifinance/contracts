// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { Client } from "@chainlink-ccip/v0.8/ccip/libraries/Client.sol";
import { IRouterClient } from "@chainlink-ccip/v0.8/ccip/interfaces/IRouterClient.sol";
import { InformationMismatch } from "../Errors/GenericErrors.sol";

/// @title CCIP Facet
/// @author Li.Finance (https://li.finance)
/// @notice Allows for bridging assets using Chainlink's CCIP protocol
/// @custom:version 0.0.1
contract CCIPFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.ccip"); // Optional. Only use if you need to store data in the diamond storage.

    // @notice the CCIP router contract
    IRouterClient public immutable routerClient;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param callData The calldata for the destination calldata
    /// @param extraArgs The extra arguments for the destination call
    struct CCIPData {
        bytes callData;
        bytes extraArgs;
    }

    /// @dev Local storage layout for CCIP
    struct Storage {
        mapping(uint256 => uint64) chainSelectors;
    }

    /// @dev Chain selector for CCIP
    /// @param chainId Standard chain ID
    /// @param selector CCIP specific chain selector
    struct ChainSelector {
        uint256 chainId;
        uint64 selector;
    }

    /// Errors ///

    error UnknownCCIPChainSelector();

    /// Events ///

    event CCIPInitialized(ChainSelector[] chainSelectors);

    event CCIPChainSelectorUpdated(uint256 indexed chainId, uint64 selector);

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _routerClient CCIP router contract.
    constructor(IRouterClient _routerClient) {
        routerClient = _routerClient;
    }

    /// Init ///

    /// @notice Initializes the CCIP facet.
    /// @param chainSelectors An array of chain selectors for CCIP
    function initCCIP(ChainSelector[] calldata chainSelectors) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        for (uint256 i = 0; i < chainSelectors.length; i++) {
            s.chainSelectors[chainSelectors[i].chainId] = chainSelectors[i]
                .selector;
        }

        emit CCIPInitialized(chainSelectors);
    }

    /// External Methods ///

    /// @notice Bridges tokens via CCIP
    /// @param _bridgeData The core information needed for bridging
    /// @param _ccipData Data specific to CCIP
    function startBridgeTokensViaCCIP(
        ILiFi.BridgeData memory _bridgeData,
        CCIPData calldata _ccipData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _ccipData);
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _ccipData);
    }

    /// @notice Performs a swap before bridging via CCIP
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _ccipData Data specific to CCIP
    function swapAndStartBridgeTokensViaCCIP(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CCIPData calldata _ccipData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        validateDestinationCallFlag(_bridgeData, _ccipData);
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _ccipData);
    }

    /// @notice Quotes the fee for bridging via CCIP
    /// @param _bridgeData The core information needed for bridging
    /// @param _ccipData Data specific to CCIP
    function quoteCCIPFee(
        ILiFi.BridgeData memory _bridgeData,
        CCIPData calldata _ccipData
    ) external view returns (uint256) {
        Client.EVMTokenAmount[] memory amounts = new Client.EVMTokenAmount[](
            1
        );
        amounts[0] = Client.EVMTokenAmount({
            token: _bridgeData.sendingAssetId,
            amount: _bridgeData.minAmount
        });

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(_bridgeData.receiver),
            data: _ccipData.callData,
            tokenAmounts: amounts,
            feeToken: address(0),
            extraArgs: _ccipData.extraArgs
        });

        return
            routerClient.getFee(
                getCCIPChainSelector(_bridgeData.destinationChainId),
                message
            );
    }

    /// @notice Encodes the extra arguments for the destination call
    /// @param gasLimit The gas limit for the destination call
    /// @param strictSequencing Whether or not to use strict sequencing (see https://docs.chain.link/ccip/best-practices#sequencing)
    function encodeDestinationArgs(
        uint256 gasLimit,
        bool strictSequencing
    ) external pure returns (bytes memory) {
        Client.EVMExtraArgsV1 memory args = Client.EVMExtraArgsV1({
            gasLimit: gasLimit,
            strict: strictSequencing
        });
        return Client._argsToBytes(args);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via CCIP
    /// @param _bridgeData The core information needed for bridging
    /// @param _ccipData Data specific to CCIP
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        CCIPData calldata _ccipData
    ) internal {
        Client.EVMTokenAmount[] memory amounts = new Client.EVMTokenAmount[](
            1
        );
        amounts[0] = Client.EVMTokenAmount({
            token: _bridgeData.sendingAssetId,
            amount: _bridgeData.minAmount
        });

        Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
            receiver: abi.encode(_bridgeData.receiver),
            data: _ccipData.callData,
            tokenAmounts: amounts,
            feeToken: address(0),
            extraArgs: _ccipData.extraArgs
        });

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(routerClient),
            _bridgeData.minAmount
        );

        routerClient.ccipSend{ value: msg.value }(
            getCCIPChainSelector(_bridgeData.destinationChainId),
            message
        );
        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Sets the CCIP chain selector for a given chain ID
    /// @param _chainId Standard chain ID
    /// @param _selector CCIP specific chain selector
    /// @dev This is used to map a chain ID to its CCIP chain selector
    function setCCIPChainSelector(
        uint256 _chainId,
        uint64 _selector
    ) external {
        LibDiamond.enforceIsContractOwner();
        Storage storage s = getStorage();

        s.chainSelectors[_chainId] = _selector;
        emit CCIPChainSelectorUpdated(_chainId, _selector);
    }

    /// @notice Gets the CCIP chain selector for a given chain ID
    /// @param _chainId Standard chain ID
    /// @return selector CCIP specific chain selector
    function getCCIPChainSelector(
        uint256 _chainId
    ) private view returns (uint64) {
        Storage storage s = getStorage();
        uint64 selector = s.chainSelectors[_chainId];
        if (selector == 0) revert UnknownCCIPChainSelector();
        return selector;
    }

    /// @dev Validates the destination call flag
    function validateDestinationCallFlag(
        ILiFi.BridgeData memory _bridgeData,
        CCIPData calldata _ccipData
    ) private pure {
        if (
            (_ccipData.callData.length > 0) != _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }
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
