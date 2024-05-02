// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

interface ISwapRouter {
    function exactInputSingle(
        ExactInputSingleParams memory params
    ) external returns (uint256 amountOut);
}

interface IGasZip {
    function deposit(
        uint256 destinationChain,
        address recipient
    ) external payable;
}

/// @title Fee Collector
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for collecting integrator fees
/// @custom:version 1.0.0
contract GasZip is TransferrableOwnership {
    address public immutable ZERO = address(0);

    /// State ///

    mapping(address => bool) public allowedInboundTokens;
    ISwapRouter public immutable uniswapRouter;
    IGasZip public immutable gasZipRouter;

    /// Errors ///
    error SwapFailed(address, address);
    error GasZipFailed(uint256);
    error TransferFailed();

    /// Events ///

    /// Constructor ///

    // solhint-disable-next-line no-empty-blocks
    constructor(
        address _owner,
        address _uniswapRouter,
        address _gasZipRouter
    ) TransferrableOwnership(_owner) {
        uniswapRouter = ISwapRouter(_uniswapRouter);
        gasZipRouter = IGasZip(_gasZipRouter);
    }

    function allowToken(address token, bool allowed) external onlyOwner {
        allowedInboundTokens[token] = allowed;
    }

    function zipERC20(
        address fromToken,
        uint256 minAmount,
        uint256 destinationChain,
        address recipient
    ) public {
        uint256 availableNative = swapERC20(fromToken, minAmount);
        gasZipRouter.deposit{ value: availableNative }(
            destinationChain,
            recipient
        );
    }

    function zip(
        uint256 amountToZip,
        uint256 destinationChain,
        address recipient
    ) public payable {
        gasZipRouter.deposit{ value: amountToZip }(
            destinationChain,
            recipient
        );
        (bool success, ) = msg.sender.call{ value: address(this).balance }("");
        if (!success) revert TransferFailed();
    }

    function swapERC20(
        address fromERC20,
        uint256 minAmount
    ) internal returns (uint256) {
        return
            uniswapRouter.exactInputSingle(
                ExactInputSingleParams({
                    tokenIn: fromERC20,
                    tokenOut: ZERO,
                    fee: 3000,
                    recipient: address(this),
                    deadline: block.timestamp,
                    amountIn: LibAsset.getOwnBalance(fromERC20),
                    amountOutMinimum: minAmount,
                    sqrtPriceLimitX96: 0
                })
            );
    }
}
