// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { Client } from "@chainlink-ccip/v0.8/ccip/libraries/Client.sol";
import { IRouterClient } from "@chainlink-ccip/v0.8/ccip/interfaces/IRouterClient.sol";

/// @title CCIP Facet
/// @author Li.Finance (https://li.finance)
/// @notice Allows for bridging assets using Chainlink's CCIP protocol
/// @custom:version 1.0.0
contract CCIPFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.ccip"); // Optional. Only use if you need to store data in the diamond storage.

    // @notice the CCIP router contract
    IRouterClient public immutable routerClient;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example paramter
    struct CCIPData {
        bytes callData;
        bytes extraArgs;
    }

    /// @dev Local storage layout for CCIP
    struct Storage {
        mapping(uint256 => uint64) chainSelectors;
    }

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
        doesNotContainDestinationCalls(_bridgeData)
    {
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
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _ccipData);
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
            receiver: abi.encode(_bridgeData),
            data: _ccipData.callData,
            tokenAmounts: amounts,
            feeToken: address(0),
            extraArgs: _ccipData.extraArgs
        });

        routerClient.ccipSend(
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

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
