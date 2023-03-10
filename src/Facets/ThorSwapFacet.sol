// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IThorSwap } from "../Interfaces/IThorSwap.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { console } from "../../test/solidity/utils/Console.sol";

/// @title ThorSwap Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through ThorSwap
contract ThorSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.thorswap");

    address public immutable tsTokenProxy;

    /// Types ///

    struct Storage {
        IThorSwap[] allowedTSRouters;
        bool initialized;
    }

    enum RouterType {
        Uniswap,
        Generic,
        Thorchain
    }

    /// @notice The struct for the ThorSwap data.
    /// @param routerType The type of router to use
    /// @param tsRouter The ThorSwap router
    /// @param tcRouter The ThorChain router
    /// @param tcVault The ThorChain vault address
    /// @param tcMemo The ThorChain memo
    /// @param token The token address
    /// @param router The router address for (generic aggregators like 1inch)
    /// @param data The data for the router
    /// @param deadline The deadline for the swap
    struct ThorSwapData {
        RouterType routerType;
        address tsRouter;
        address tcRouter;
        address tcVault;
        string tcMemo;
        address token;
        address router;
        bytes data;
        uint256 deadline;
    }

    /// Errors ///

    error RouterNotAllowed();

    /// Events ///

    event ThorSwapInitialized(IThorSwap[] allowedTSRouters);

    /// @notice Initializes the ThorSwap contract
    constructor(address _tsTokenProxy) {
        tsTokenProxy = _tsTokenProxy;
    }

    // Init ///

    /// @notice Initialize local variables for the ThorSwap Facet
    /// @param _allowedTSRouters Allowed ThorSwap routers
    function initThorSwap(IThorSwap[] calldata _allowedTSRouters) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (s.initialized) {
            revert AlreadyInitialized();
        }

        s.allowedTSRouters = _allowedTSRouters;
        s.initialized = true;

        emit ThorSwapInitialized(_allowedTSRouters);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _thorSwapData The ThorSwap data struct
    function startBridgeTokensViaThorSwap(
        ILiFi.BridgeData memory _bridgeData,
        ThorSwapData calldata _thorSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        Storage storage s = getStorage();

        if (!s.initialized) {
            revert NotInitialized();
        }

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _thorSwapData);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _swapData The swap data struct
    /// @param _thorSwapData The ThorSwap data struct
    function swapAndStartBridgeTokensViaThorSwap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        ThorSwapData calldata _thorSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        Storage storage s = getStorage();

        if (!s.initialized) {
            revert NotInitialized();
        }

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _thorSwapData);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _thorSwapData The thorSwap data struct for ThorSwap specicific data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ThorSwapData calldata _thorSwapData
    ) internal {
        if (!routerIsAllowed(IThorSwap(_thorSwapData.tsRouter))) {
            revert RouterNotAllowed();
        }

        IERC20 sendingAssetId = IERC20(_bridgeData.sendingAssetId);
        bool isNative = LibAsset.isNativeAsset(address(sendingAssetId));

        // Send straight to ThorChain
        if (_thorSwapData.routerType == RouterType.Thorchain) {
            if (!isNative) {
                LibAsset.maxApproveERC20(
                    sendingAssetId,
                    tsTokenProxy,
                    _bridgeData.minAmount
                );
            }
            IThorSwap(_thorSwapData.tsRouter).depositWithExpiry{
                value: isNative ? _bridgeData.minAmount : 0
            }(
                _thorSwapData.tcVault,
                _thorSwapData.token,
                _bridgeData.minAmount,
                _thorSwapData.tcMemo,
                _thorSwapData.deadline
            );

            emit LiFiTransferStarted(_bridgeData);
            return;
        }

        LibAsset.maxApproveERC20(
            sendingAssetId,
            tsTokenProxy,
            _bridgeData.minAmount
        );

        // Uniswap Style Aggregator
        if (_thorSwapData.routerType == RouterType.Uniswap) {
            IThorSwap(_thorSwapData.tsRouter).swapIn(
                _thorSwapData.tcRouter,
                _thorSwapData.tcVault,
                _thorSwapData.tcMemo,
                _thorSwapData.token,
                _bridgeData.minAmount,
                _bridgeData.minAmount,
                _thorSwapData.deadline
            );
        }

        // Generic Aggregator
        if (_thorSwapData.routerType == RouterType.Generic) {
            IThorSwap(_thorSwapData.tsRouter).swapIn(
                _thorSwapData.tcRouter,
                _thorSwapData.tcVault,
                _thorSwapData.tcMemo,
                _thorSwapData.token,
                _bridgeData.minAmount,
                _thorSwapData.router,
                _thorSwapData.data,
                _thorSwapData.deadline
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Checks if a router is allowed
    /// @param _router The router to check
    /// @return True if the router is allowed
    function routerIsAllowed(IThorSwap _router) private view returns (bool) {
        Storage storage s = getStorage();
        for (uint256 i = 0; i < s.allowedTSRouters.length; i++) {
            if (s.allowedTSRouters[i] == _router) {
                return true;
            }
        }
        return false;
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
