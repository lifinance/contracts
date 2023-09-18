// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title CCIP Facet
/// @author Li.Finance (https://li.finance)
/// @notice Allows for bridging assets using Chainlink's CCIP protocol
/// @custom:version 1.0.0
contract CCIPFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.ccip"); // Optional. Only use if you need to store data in the diamond storage.

    /// @dev Local storage for the contract (optional)
    struct Storage {
        address[] exampleAllowedTokens;
    }

    address public immutable example;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example paramter
    struct CCIPData {
        string exampleParam;
    }

    /// Events ///

    event CCIPInitialized();

    /// Constructor ///

    /// @notice Constructor for the contract.
    ///         Should only be used to set immutable variables.
    ///         Anything that cannot be set as immutable should be set
    ///         in an init() function called during a diamondCut().
    /// @param _example Example paramter.
    constructor(address _example) {
        example = _example;
    }

    /// Init ///

    /// @notice Init function. Called in the context
    ///         of the diamond contract when added as part of
    ///         a diamondCut(). Use for config that can't be
    ///         set as immutable or needs to change for any reason.
    /// @param _exampleAllowedTokens Example array of allowed tokens for this chain.
    function initCCIP(address[] memory _exampleAllowedTokens) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();
        s.exampleAllowedTokens = _exampleAllowedTokens;

        emit CCIPInitialized();
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
        // TODO: Implement business logic
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
