// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { IAxelarExecutable } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarExecutable.sol";
import { IAxelarGasService } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGasService.sol";
import { IAxelarGateway } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IAxelarGateway.sol";
import { IERC20 } from "@axelar-network/axelar-cgp-solidity/contracts/interfaces/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IERC20Proxy } from "../Interfaces/IERC20Proxy.sol";
import "../Libraries/LibBytes.sol";

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract Executor is IAxelarExecutable, Ownable, ReentrancyGuard, ILiFi {
    using LibBytes for bytes;

    /// Storage ///
    address public sgRouter;
    IERC20Proxy public erc20Proxy;

    /// Errors ///
    error ExecutionFailed();
    error InvalidStargateRouter();
    error InvalidCaller();
    error UnAuthorized();
    error NotAContract();

    /// Events ///
    event AxelarGatewaySet(address indexed gateway);
    event StargateRouterSet(address indexed router);
    event ERC20ProxySet(address indexed proxy);
    event AxelarExecutionComplete(address indexed callTo, bytes4 selector);

    /// Modifiers ///

    /// @dev Sends any leftover balances back to the user
    modifier noLeftovers(LibSwap.SwapData[] calldata _swapData, address payable _receiver) {
        uint256 nSwaps = _swapData.length;
        if (nSwaps != 1) {
            uint256[] memory initialBalances = _fetchBalances(_swapData);
            address finalAsset = _swapData[nSwaps - 1].receivingAssetId;
            uint256 curBalance = 0;

            _;

            for (uint256 i = 0; i < nSwaps - 1; i++) {
                address curAsset = _swapData[i].receivingAssetId;
                if (curAsset == finalAsset) continue; // Handle multi-to-one swaps
                curBalance = LibAsset.getOwnBalance(curAsset) - initialBalances[i];
                if (curBalance > 0) LibAsset.transferAsset(curAsset, _receiver, curBalance);
            }
        } else _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _gateway,
        address _sgRouter,
        address _erc20Proxy
    ) IAxelarExecutable(_gateway) {
        transferOwnership(_owner);
        sgRouter = _sgRouter;
        erc20Proxy = IERC20Proxy(_erc20Proxy);
        emit AxelarGatewaySet(_gateway);
        emit StargateRouterSet(_sgRouter);
        emit ERC20ProxySet(_erc20Proxy);
    }

    /// External Methods ///

    /// @notice set the Axelar gateway
    /// @param _gateway the Axelar gateway address
    function setAxelarGateway(address _gateway) external onlyOwner {
        gateway = IAxelarGateway(_gateway);
        emit AxelarGatewaySet(_gateway);
    }

    /// @notice set Stargate Router
    /// @param _router the Stargate router address
    function setStargateRouter(address _router) external onlyOwner {
        sgRouter = _router;
        emit StargateRouterSet(_router);
    }

    /// @notice set ERC20 Proxy
    /// @param _erc20Proxy the address of the ERC20Proxy contract
    function setERC20Proxy(address _erc20Proxy) external onlyOwner {
        erc20Proxy = IERC20Proxy(_erc20Proxy);
        emit ERC20ProxySet(_erc20Proxy);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain.
    /// @dev This function is called from Stargate Router.
    /// @param * (unused) The remote chainId sending the tokens
    /// @param * (unused) The remote Bridge address
    /// @param * (unused) Nonce
    /// @param * (unused) The token contract on the local chain
    /// @param * (unused) The amount of local _token contract tokens
    /// @param _payload The data to execute
    function sgReceive(
        uint16, // _srcChainId unused
        bytes memory, // _srcAddress unused
        uint256, // _nonce unused
        address, // _token unused
        uint256, // _amountLD unused
        bytes memory _payload
    ) external {
        if (msg.sender != address(sgRouter)) {
            revert InvalidStargateRouter();
        }

        (LiFiData memory lifiData, LibSwap.SwapData[] memory swapData, address assetId, address receiver) = abi.decode(
            _payload,
            (LiFiData, LibSwap.SwapData[], address, address)
        );

        this.swapAndCompleteBridgeTokensViaStargate(lifiData, swapData, assetId, payable(receiver));
    }

    /// @dev used to execute calls received by Stargate specifically
    function swapAndCompleteBridgeTokensViaStargate(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address transferredAssetId,
        address payable receiver
    ) external payable nonReentrant {
        if (msg.sender != address(this)) {
            revert InvalidCaller();
        }

        uint256 startingBalance;
        uint256 finalAssetStartingBalance;
        address finalAssetId = _swapData[_swapData.length - 1].receivingAssetId;

        if (!LibAsset.isNativeAsset(finalAssetId)) {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId);
        } else {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId) - msg.value;
        }

        if (!LibAsset.isNativeAsset(transferredAssetId)) {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId);
        } else {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId) - msg.value;
        }

        _executeSwaps(_lifiData, _swapData, receiver);

        uint256 postSwapBalance = LibAsset.getOwnBalance(transferredAssetId);
        if (postSwapBalance > startingBalance) {
            LibAsset.transferAsset(transferredAssetId, receiver, postSwapBalance - startingBalance);
        }

        uint256 finalAssetPostSwapBalance = LibAsset.getOwnBalance(finalAssetId);
        if (finalAssetPostSwapBalance > finalAssetStartingBalance) {
            LibAsset.transferAsset(finalAssetId, receiver, finalAssetPostSwapBalance - finalAssetStartingBalance);
        }

        emit LiFiTransferCompleted(
            _lifiData.transactionId,
            transferredAssetId,
            receiver,
            _swapData[0].fromAmount,
            block.timestamp
        );
    }

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param transferredAssetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    function swapAndCompleteBridgeTokens(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address transferredAssetId,
        address payable receiver
    ) external payable nonReentrant {
        uint256 startingBalance;
        uint256 finalAssetStartingBalance;
        address finalAssetId = _swapData[_swapData.length - 1].receivingAssetId;

        if (!LibAsset.isNativeAsset(finalAssetId)) {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId);
        } else {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId) - msg.value;
        }

        if (!LibAsset.isNativeAsset(transferredAssetId)) {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId);
            uint256 allowance = IERC20(transferredAssetId).allowance(msg.sender, address(this));
            LibAsset.depositAsset(transferredAssetId, allowance);
        } else {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId) - msg.value;
        }

        _executeSwaps(_lifiData, _swapData, receiver);

        uint256 postSwapBalance = LibAsset.getOwnBalance(transferredAssetId);
        if (postSwapBalance > startingBalance) {
            LibAsset.transferAsset(transferredAssetId, receiver, postSwapBalance - startingBalance);
        }

        uint256 finalAssetPostSwapBalance = LibAsset.getOwnBalance(finalAssetId);
        if (finalAssetPostSwapBalance > finalAssetStartingBalance) {
            LibAsset.transferAsset(finalAssetId, receiver, finalAssetPostSwapBalance - finalAssetStartingBalance);
        }

        emit LiFiTransferCompleted(
            _lifiData.transactionId,
            transferredAssetId,
            receiver,
            _swapData[0].fromAmount,
            block.timestamp
        );
    }

    /// @notice Performs a series of swaps or arbitrary executions
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param transferredAssetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    function swapAndExecute(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address transferredAssetId,
        address payable receiver,
        uint256 amount
    ) external payable nonReentrant {
        uint256 startingBalance;
        uint256 finalAssetStartingBalance;
        address finalAssetId = _swapData[_swapData.length - 1].receivingAssetId;

        if (!LibAsset.isNativeAsset(finalAssetId)) {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId);
        } else {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId) - msg.value;
        }

        if (!LibAsset.isNativeAsset(transferredAssetId)) {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId);
            erc20Proxy.transferFrom(transferredAssetId, msg.sender, address(this), amount);
        } else {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId) - msg.value;
        }

        _executeSwaps(_lifiData, _swapData, receiver);

        uint256 postSwapBalance = LibAsset.getOwnBalance(transferredAssetId);
        if (postSwapBalance > startingBalance) {
            LibAsset.transferAsset(transferredAssetId, receiver, postSwapBalance - startingBalance);
        }

        uint256 finalAssetPostSwapBalance = LibAsset.getOwnBalance(finalAssetId);
        if (finalAssetPostSwapBalance > finalAssetStartingBalance) {
            LibAsset.transferAsset(finalAssetId, receiver, finalAssetPostSwapBalance - finalAssetStartingBalance);
        }

        emit LiFiTransferCompleted(_lifiData.transactionId, transferredAssetId, receiver, amount, block.timestamp);
    }

    /// Internal Methods ///

    /// @dev override of IAxelarExecutable _execute()
    /// @notice handles the parsing and execution of the payload
    /// @param payload the abi.encodePacked payload [callTo:callData]
    function _execute(
        string memory,
        string memory,
        bytes calldata payload
    ) internal override nonReentrant {
        // The first 20 bytes of the payload are the callee address
        address callTo = payload.toAddress(0);

        if (!_isContract(callTo)) revert NotAContract();
        if (callTo == address(erc20Proxy)) revert UnAuthorized();

        // The remaining bytes should be calldata
        bytes memory callData = payload.slice(20, payload.length - 20);

        (bool success, ) = callTo.call(callData);
        if (!success) revert ExecutionFailed();
        emit AxelarExecutionComplete(callTo, bytes4(callData));
    }

    /// @dev override of IAxelarExecutable _executeWithToken()
    /// @notice handles the parsing and execution of the payload
    /// @param payload the abi.encodePacked payload [callTo:callData]
    function _executeWithToken(
        string memory,
        string memory,
        bytes calldata payload,
        string memory tokenSymbol,
        uint256 amount
    ) internal override nonReentrant {
        // The first 20 bytes of the payload are the callee address
        address callTo = payload.toAddress(0);

        if (!_isContract(callTo)) revert NotAContract();
        if (callTo == address(erc20Proxy)) revert UnAuthorized();

        // The remaining bytes should be calldata
        bytes memory callData = payload.slice(20, payload.length - 20);

        // get ERC-20 address from gateway
        address tokenAddress = gateway.tokenAddresses(tokenSymbol);

        // transfer received tokens to the recipient
        IERC20(tokenAddress).approve(callTo, amount);

        (bool success, ) = callTo.call(callData);
        if (!success) revert ExecutionFailed();
    }

    /// Private Methods ///

    /// @dev Executes swaps one after the other
    /// @param _lifiData LiFi tracking data
    /// @param _swapData Array of data used to execute swaps
    function _executeSwaps(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address payable _receiver
    ) private noLeftovers(_swapData, _receiver) {
        for (uint256 i = 0; i < _swapData.length; i++) {
            if (_swapData[i].callTo == address(erc20Proxy)) revert UnAuthorized(); // Prevent calling ERC20 Proxy directly
            LibSwap.SwapData calldata currentSwapData = _swapData[i];
            LibSwap.swap(_lifiData.transactionId, currentSwapData);
        }
    }

    /// @dev Fetches balances of tokens to be swapped before swapping.
    /// @param _swapData Array of data used to execute swaps
    /// @return uint256[] Array of token balances.
    function _fetchBalances(LibSwap.SwapData[] calldata _swapData) private view returns (uint256[] memory) {
        uint256 length = _swapData.length;
        uint256[] memory balances = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            balances[i] = LibAsset.getOwnBalance(_swapData[i].receivingAssetId);
        }
        return balances;
    }

    /// @dev Checks if address is a contract address
    /// @param addr the address to check
    /// @return bool whether or not address is a contract
    function _isContract(address addr) private view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(addr)
        }
        return size > 0;
    }
}
