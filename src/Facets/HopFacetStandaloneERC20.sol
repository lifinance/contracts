// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount, InvalidConfig, InvalidSendingToken, AlreadyInitialized, NotInitialized, OnlyContractOwner } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Hop Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacetStandaloneERC20 is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address public owner;
    mapping(address => IHopBridge) internal bridges;
    bool private _facetInitialized;

    struct Storage {
        mapping(address => IHopBridge) bridges;
        bool initialized;
    }

    /// Types ///

    struct Config {
        address assetId;
        address bridge;
    }

    struct HopData {
        uint256 bonderFee;
        uint256 amountOutMin;
        uint256 deadline;
        uint256 destinationAmountOutMin;
        uint256 destinationDeadline;
    }

    /// Events ///

    event HopInitialized(Config[] configs);
    event HopBridgeRegistered(address indexed assetId, address bridge);

    constructor() {
        owner = msg.sender;
    }

    /// Init ///

    /// @notice Initialize local variables for the Hop Facet
    /// @param configs Bridge configuration data
    function initHop(Config[] calldata configs) external {
        if (msg.sender != owner) revert OnlyContractOwner();

        // not checking if already initialized since this function is owner-access only and we know what to do

        for (uint256 i = 0; i < configs.length; i++) {
            if (configs[i].bridge == address(0)) {
                revert InvalidConfig();
            }
            bridges[configs[i].assetId] = IHopBridge(configs[i].bridge);
        }
        _facetInitialized = true;
        emit HopInitialized(configs);
    }

    /// External Methods ///

    /// @notice Register token and bridge
    /// @param assetId Address of token
    /// @param bridge Address of bridge for asset
    function registerBridge(address assetId, address bridge) external {
        if (msg.sender != owner) revert OnlyContractOwner();

        if (!_facetInitialized) {
            revert NotInitialized();
        }

        if (bridge == address(0)) {
            revert InvalidConfig();
        }

        bridges[assetId] = IHopBridge(bridge);

        emit HopBridgeRegistered(assetId, bridge);
    }

    /// @notice Bridges tokens via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHop(ILiFi.BridgeData memory _bridgeData, HopData calldata _hopData)
        external
        payable
        nonReentrant //! this one would save 8000 gas (4% of the test case) - I would like to challenge if we really need it here
        //! on destination side I see that we need it but here, I am not sure
        refundExcessNative(payable(msg.sender)) //! I would opt to remove this: saves 135 gas only though
    {
        transferFromERC202(_bridgeData.sendingAssetId, msg.sender, address(this), _bridgeData.minAmount);
        _startBridge(_bridgeData, _hopData);
    }

    /// @notice Performs a swap before bridging via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHop(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData memory _hopData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender)) //! I would opt to remove this, too, since it should produce a cheaper quote
    {
        _bridgeData.minAmount = _depositAndSwap2(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _hopData);
    }

    /// private Methods ///

    /// @dev Contains the business logic for the bridge via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function _startBridge(ILiFi.BridgeData memory _bridgeData, HopData memory _hopData) private {
        // Do HOP stuff
        address sendingAssetId = _bridgeData.sendingAssetId;
        IHopBridge bridge = bridges[sendingAssetId];

        // Give Hop approval to bridge tokens
        uint256 allowance = IERC20(sendingAssetId).allowance(address(this), address(bridge));
        if (allowance < _bridgeData.minAmount)
            SafeERC20.safeIncreaseAllowance(IERC20(sendingAssetId), address(bridge), type(uint256).max - allowance);

        if (block.chainid == 1) {
            // Ethereum L1
            bridge.sendToL2(
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline,
                address(0),
                0
            );
        } else {
            // L2
            // solhint-disable-next-line check-send-result
            bridge.swapAndSend(
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _hopData.bonderFee,
                _hopData.amountOutMin,
                _hopData.deadline,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline
            );
        }
        emit LiFiTransferStarted(_bridgeData);
    }

    //! the following functions are copied from libraries/parent contracts and slightly adjusted/reduced
    // function depositAsset2(address assetId, uint256 amount) internal {
    //     if (assetId == address(0)) {
    //         // if (msg.value < amount) revert InvalidAmount(); //! WILL FAIL LATER ON ANYWAY
    //     } else {
    //         // if (amount == 0) revert InvalidAmount();
    //         // uint256 balance = IERC20(assetId).balanceOf(msg.sender);
    //         // if (balance < amount) revert InsufficientBalance(amount, balance);
    //         transferFromERC202(assetId, msg.sender, address(this), amount);
    //     }
    // }

    function transferFromERC202(
        address assetId,
        address from,
        address to,
        uint256 amount
    ) internal {
        // if (assetId == NATIVE_ASSETID) revert NullAddrIsNotAnERC20Token();
        // if (to == NULL_ADDRESS) revert NoTransferToNullAddress();

        IERC20 asset = IERC20(assetId);
        uint256 prevBalance = asset.balanceOf(to);
        SafeERC20.safeTransferFrom(asset, from, to, amount);
        if (asset.balanceOf(to) - prevBalance != amount) revert InvalidAmount(); //! IMPORTANT FOR TOKENS WITH FEES
    }

    function _depositAndSwap2(
        bytes32 _transactionId,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swaps,
        address payable _leftoverReceiver
    ) internal returns (uint256) {
        // address finalTokenId = _swaps[_swaps.length - 1].receivingAssetId;
        // uint256 initialBalance = LibAsset.getOwnBalance(finalTokenId);
        // if (LibAsset.isNativeAsset(finalTokenId)) {
        //     initialBalance -= msg.value;
        // }
        // uint256[] memory initialBalances = _fetchBalances(_swaps);
        // LibAsset.depositAssets(_swaps);
        // _executeSwaps(_transactionId, _swaps, _leftoverReceiver, initialBalances);
        // uint256 newBalance = LibAsset.getOwnBalance(finalTokenId) - initialBalance;
        // if (newBalance < _minAmount) {
        //     revert CumulativeSlippageTooHigh(_minAmount, newBalance);
        // }
        // return newBalance;
    }

    function getOwnBalance(address assetId) internal view returns (uint256) {
        return assetId == address(0) ? address(this).balance : IERC20(assetId).balanceOf(address(this));
    }
}
