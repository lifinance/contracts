// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IMultichainToken } from "../Interfaces/IMultichainToken.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { IMultichainRouter } from "../Interfaces/IMultichainRouter.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { TokenAddressIsZero, CannotBridgeToSameNetwork, InvalidConfig, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { console } from "test/solidity/utils/Console.sol"; // TODO: REMOVE

interface IMultichainERC20 {
    function Swapout(uint256 amount, address bindaddr) external returns (bool);
}

/// @title Multichain Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Multichain (Prev. AnySwap)
contract MultichainFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.multichain");

    struct Storage {
        mapping(address => bool) allowedRouters;
        bool initialized;
    }

    /// Types ///

    struct MultichainData {
        address router;
    }

    /// Errors ///
    error InvalidRouter();

    /// Events ///

    event MultichainInitialized();
    event MultichainRouterRegistered(address indexed router, bool allowed);

    /// Init ///

    /// @notice Initialize local variables for the Multichain Facet
    /// @param routers Allowed Multichain Routers
    function initMultichain(address[] calldata routers) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (s.initialized) {
            revert AlreadyInitialized();
        }

        uint256 len = routers.length;
        for (uint256 i = 0; i < len; ) {
            if (routers[i] == address(0)) {
                revert InvalidConfig();
            }
            s.allowedRouters[routers[i]] = true;
            unchecked {
                ++i;
            }
        }

        s.initialized = true;

        emit MultichainInitialized();
    }

    /// External Methods ///

    /// @notice Register router
    /// @param router Address of the router
    /// @param allowed Whether the address is allowed or not
    function registerBridge(address router, bool allowed) external {
        LibDiamond.enforceIsContractOwner();

        if (router == address(0)) {
            revert InvalidConfig();
        }

        Storage storage s = getStorage();

        if (!s.initialized) {
            revert NotInitialized();
        }

        s.allowedRouters[router] = allowed;

        emit MultichainRouterRegistered(router, allowed);
    }

    /// @notice Batch register routers
    /// @param routers Router addresses
    /// @param allowed Array of whether the addresses are allowed or not
    function registerBridge(address[] calldata routers, bool[] calldata allowed) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (!s.initialized) {
            revert NotInitialized();
        }

        uint256 len = routers.length;
        for (uint256 i = 0; i < len; ) {
            if (routers[i] == address(0)) {
                revert InvalidConfig();
            }
            s.allowedRouters[routers[i]] = allowed[i];

            emit MultichainRouterRegistered(routers[i], allowed[i]);

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Bridges tokens via Multichain
    /// @param _bridgeData the core information needed for bridging
    /// @param _multichainData data specific to Multichain
    function startBridgeTokensViaMultichain(
        ILiFi.BridgeData memory _bridgeData,
        MultichainData calldata _multichainData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        Storage storage s = getStorage();
        if (!s.allowedRouters[_multichainData.router]) revert InvalidRouter();

        // Multichain (formerly Multichain) tokens can wrap other tokens
        address underlyingToken;
        bool isNative;
        // check if sendingAsset is Multichain token (> special flow)
        if (_multichainData.router != _bridgeData.sendingAssetId) {
            (underlyingToken, isNative) = _getUnderlyingToken(_bridgeData.sendingAssetId, _multichainData.router);
        } else {
            underlyingToken = _bridgeData.sendingAssetId;
        }
        if (!isNative) LibAsset.depositAsset(underlyingToken, _bridgeData.minAmount);
        _startBridge(_bridgeData, _multichainData, underlyingToken, isNative);
    }

    /// @notice Performs a swap before bridging via Multichain
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _multichainData data specific to Multichain
    function swapAndStartBridgeTokensViaMultichain(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MultichainData memory _multichainData
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

        if (!s.allowedRouters[_multichainData.router]) revert InvalidRouter();

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        address underlyingToken;
        bool isNative;
        // check if sendingAsset is Multichain token (> special flow)
        if (_multichainData.router != _bridgeData.sendingAssetId) {
            (underlyingToken, isNative) = _getUnderlyingToken(_bridgeData.sendingAssetId, _multichainData.router);
        } else {
            underlyingToken = _bridgeData.sendingAssetId;
        }
        _startBridge(_bridgeData, _multichainData, underlyingToken, isNative);
    }

    /// Private Methods ///

    /// @dev Unwraps the underlying token from the Multichain token if necessary
    /// @param token The (maybe) wrapped token
    /// @param router The Multichain router
    function _getUnderlyingToken(address token, address router)
        private
        returns (address underlyingToken, bool isNative)
    {
        // Token must implement IMultichainToken interface
        if (LibAsset.isNativeAsset(token)) revert TokenAddressIsZero();
        underlyingToken = IMultichainToken(token).underlying();
        // The native token does not use the standard null address ID
        isNative = IMultichainRouter(router).wNATIVE() == underlyingToken;
        // Some Multichain complying tokens may wrap nothing
        if (!isNative && LibAsset.isNativeAsset(underlyingToken)) {
            underlyingToken = token;
        }
    }

    /// @dev Contains the business logic for the bridge via Multichain
    /// @param _bridgeData the core information needed for bridging
    /// @param _multichainData data specific to Multichain
    /// @param underlyingToken the underlying token to swap
    /// @param isNative denotes whether the token is a native token vs ERC20
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MultichainData memory _multichainData,
        address underlyingToken,
        bool isNative
    ) private preventBridgingToSameChainId(_bridgeData) {
        // check if sendingAsset is a Multichain token that needs to be called directly in order to bridge it
        if (_multichainData.router == _bridgeData.sendingAssetId) {
            IMultichainERC20(_bridgeData.sendingAssetId).Swapout(_bridgeData.minAmount, _bridgeData.receiver);
        } else {
            if (isNative) {
                IMultichainRouter(_multichainData.router).anySwapOutNative{ value: _bridgeData.minAmount }(
                    _bridgeData.sendingAssetId,
                    _bridgeData.receiver,
                    _bridgeData.destinationChainId
                );
            } else {
                // Give Multichain approval to bridge tokens
                LibAsset.maxApproveERC20(IERC20(underlyingToken), _multichainData.router, _bridgeData.minAmount);
                // Was the token wrapping another token?
                if (_bridgeData.sendingAssetId != underlyingToken) {
                    IMultichainRouter(_multichainData.router).anySwapOutUnderlying(
                        _bridgeData.sendingAssetId,
                        _bridgeData.receiver,
                        _bridgeData.minAmount,
                        _bridgeData.destinationChainId
                    );
                } else {
                    IMultichainRouter(_multichainData.router).anySwapOut(
                        _bridgeData.sendingAssetId,
                        _bridgeData.receiver,
                        _bridgeData.minAmount,
                        _bridgeData.destinationChainId
                    );
                }
            }
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
