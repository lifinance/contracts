// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.17;

import { Test, DSTest } from "forge-std/Test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { GasZip } from "lifi/Periphery/GasZip.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { ERC20 } from "solady/tokens/ERC20.sol";

contract GasZipTest is Test {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x9E22ebeC84c7e4C4bD6D4aE7FF6f4D436D6D8390;
    address internal ADDRESS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal ADDRESS_UNISWAP =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    GasZip public gasZip;
    uint256 public defaultDestinationChains = 96;
    address public defaultRecipient = address(12345);
    address public defaultRefundAddress = address(56789);
    uint256 public defaultNativeAmount = 0.0006 ether;
    uint256 public defaultUSDCAmount = 10e6;
    UniswapV2Router02 public uniswap;

    event Deposit(address from, uint256 chains, uint256 amount, address to);

    function setUp() public {
        fork();
        gasZip = new GasZip(GAS_ZIP_ROUTER_MAINNET);

        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);

        deal(address(this), 1 ether);
    }

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 20173181;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function test_contractIsSetUpCorrectly() public {
        gasZip = new GasZip(GAS_ZIP_ROUTER_MAINNET);
        assertEq(address(gasZip.gasZipRouter()), GAS_ZIP_ROUTER_MAINNET);
    }

    function test_canDepositNative() public {
        // set up expected event
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZip),
            defaultDestinationChains,
            defaultNativeAmount,
            defaultRecipient
        );

        // deposit via GasZip periphery contract
        gasZip.zip{ value: defaultNativeAmount }(
            defaultNativeAmount,
            defaultDestinationChains,
            defaultRecipient
        );
    }

    function test_canSwapERC20ToNativeAndDeposit() public {
        (
            LibSwap.SwapData memory swapData,
            uint256 amountOutMin
        ) = _getUniswapCalldataForERC20ToNativeSwap(
                ADDRESS_USDC,
                defaultUSDCAmount
            );

        deal(ADDRESS_USDC, address(this), defaultUSDCAmount);

        ERC20(ADDRESS_USDC).approve(address(gasZip), defaultUSDCAmount);

        // set up expected event
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZip),
            defaultDestinationChains,
            amountOutMin,
            defaultRecipient
        );

        // deposit via GasZip periphery contract
        gasZip.zipERC20(
            swapData,
            defaultDestinationChains,
            defaultRecipient,
            defaultRefundAddress
        );
    }

    function _getUniswapCalldataForERC20ToNativeSwap(
        address sendingAssetId,
        uint256 fromAmount
    )
        internal
        view
        returns (LibSwap.SwapData memory swapData, uint256 amountOutMin)
    {
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = sendingAssetId;
        path[1] = ADDRESS_WETH;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(fromAmount, path);
        amountOutMin = amounts[1];

        swapData = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            sendingAssetId,
            ADDRESS_WETH,
            fromAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector,
                fromAmount,
                amountOutMin,
                path,
                address(gasZip),
                block.timestamp + 20 seconds
            ),
            true
        );
    }
}
