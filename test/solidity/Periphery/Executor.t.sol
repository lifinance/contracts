// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { Executor } from "lifi/Periphery/Executor.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { TestAMM } from "../utils/TestAMM.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";

// Stub Vault Contract
contract Vault {
    function deposit(address token, uint256 amount) external {
        ERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}

contract Setter {
    string public message;

    function setMessage(string calldata _message) external {
        message = _message;
    }
}

contract MockGateway {
    mapping(string => address) public tokenAddresses;

    function validateContractCall(
        bytes32,
        string calldata,
        string calldata,
        bytes32
    ) external pure returns (bool) {
        return true;
    }

    function validateContractCallAndMint(
        bytes32,
        string calldata,
        string calldata,
        bytes32,
        string memory,
        uint256
    ) external pure returns (bool) {
        return true;
    }

    function setTokenAddress(
        string memory _symbol,
        address _tokenAddress
    ) external {
        tokenAddresses[_symbol] = _tokenAddress;
    }
}

contract ExecutorTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    Executor internal executor;
    TestAMM internal amm;
    Vault internal vault;
    Setter internal setter;
    MockGateway internal gw;
    ERC20Proxy internal erc20Proxy;

    function setUp() public {
        gw = new MockGateway();
        erc20Proxy = new ERC20Proxy(address(this));
        executor = new Executor(address(erc20Proxy));
        vm.makePersistent(address(executor));
        erc20Proxy.setAuthorizedCaller(address(executor), true);
        amm = new TestAMM();
        vault = new Vault();
        setter = new Setter();
    }

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 14847528;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function testCanPerformComplexSwap() public {
        ERC20 tokenA = new ERC20("Token A", "TOKA", 18);
        ERC20 tokenB = new ERC20("Token B", "TOKB", 18);
        ERC20 tokenC = new ERC20("Token C", "TOKC", 18);
        ERC20 tokenD = new ERC20("Token D", "TOKD", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](6);

        // Get some Token B
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenB),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                1_000 ether,
                tokenB,
                101 ether
            ),
            true
        );

        // Get some Token C
        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenC),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                1_000 ether,
                tokenC,
                102 ether
            ),
            false
        );

        // Get some Token D
        swapData[2] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenD),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                1_000 ether,
                tokenD,
                103 ether
            ),
            false
        );

        // Deposit Token B
        swapData[3] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenB),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenB),
                100 ether
            ),
            true
        );

        // Deposit Token C
        swapData[4] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenC),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenC),
                100 ether
            ),
            true
        );

        // Deposit Token D
        swapData[5] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenD),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenD),
                100 ether
            ),
            true
        );

        tokenA.mint(address(this), 4_000 ether);
        tokenA.mint(address(executor), 10 ether); // Add some accidental tokens to contract
        tokenA.approve(address(executor), 4_000 ether);
        executor.swapAndCompleteBridgeTokens(
            "",
            swapData,
            address(tokenA),
            payable(address(0xb33f))
        );

        assertEq(tokenA.balanceOf(address(executor)), 10 ether); // Pre execution balance
        assertEq(tokenA.balanceOf(address(0xb33f)), 1_000 ether);
        assertEq(tokenB.balanceOf(address(0xb33f)), 1 ether); // Positive slippage
        assertEq(tokenC.balanceOf(address(0xb33f)), 2 ether); // Positive slippage
        assertEq(tokenD.balanceOf(address(0xb33f)), 3 ether); // Positive slippage
        assertEq(tokenB.balanceOf(address(vault)), 100 ether);
        assertEq(tokenC.balanceOf(address(vault)), 100 ether);
        assertEq(tokenD.balanceOf(address(vault)), 100 ether);
    }

    function testCanReceiveNativeTokensFromDestinationSwap() public {
        fork();
        address DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
        address payable DAI_WHALE = payable(
            address(0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD)
        );
        address WETH_ADDRESS = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        address UNISWAP_V2_ROUTER_ADDRESS = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
        ERC20 dai = ERC20(DAI_ADDRESS);
        ERC20 weth = ERC20(WETH_ADDRESS);
        UniswapV2Router02 uniswap = UniswapV2Router02(
            UNISWAP_V2_ROUTER_ADDRESS
        );

        vm.startPrank(DAI_WHALE);
        // Swap DAI -> WETH
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = WETH_ADDRESS;

        uint256 amountOut = 1_000 * 10 ** weth.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            WETH_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector,
                amountIn,
                amountOut,
                path,
                address(executor),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Approve DAI
        dai.approve(address(executor), amountIn);

        executor.swapAndCompleteBridgeTokens(
            "txId",
            swapData,
            DAI_ADDRESS,
            DAI_WHALE
        );
        vm.stopPrank();
    }

    function testCanPerformComplexSwapWithNativeToken() public {
        ERC20 tokenB = new ERC20("Token B", "TOKB", 18);
        ERC20 tokenC = new ERC20("Token C", "TOKC", 18);
        ERC20 tokenD = new ERC20("Token D", "TOKD", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](6);

        // Get some Token B
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(0),
            address(tokenB),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                address(0),
                1_000 ether,
                tokenB,
                101 ether
            ),
            true
        );

        // Get some Token C
        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(0),
            address(tokenC),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                address(0),
                1_000 ether,
                tokenC,
                102 ether
            ),
            false
        );

        // Get some Token D
        swapData[2] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(0),
            address(tokenD),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                address(0),
                1_000 ether,
                tokenD,
                103 ether
            ),
            false
        );

        // Deposit Token B
        swapData[3] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenB),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenB),
                100 ether
            ),
            true
        );

        // Deposit Token C
        swapData[4] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenC),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenC),
                100 ether
            ),
            true
        );

        // Deposit Token D
        swapData[5] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenD),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenD),
                100 ether
            ),
            true
        );

        vm.deal(address(executor), 10 ether);

        executor.swapAndCompleteBridgeTokens{ value: 4_000 ether }(
            "",
            swapData,
            address(0),
            payable(address(0xb33f))
        );

        assertEq(address(executor).balance, 10 ether); // Pre execution balance
        assertEq(address(0xb33f).balance, 1_000 ether);
        assertEq(tokenB.balanceOf(address(0xb33f)), 1 ether); // Positive slippage
        assertEq(tokenC.balanceOf(address(0xb33f)), 2 ether); // Positive slippage
        assertEq(tokenD.balanceOf(address(0xb33f)), 3 ether); // Positive slippage
        assertEq(tokenB.balanceOf(address(vault)), 100 ether);
        assertEq(tokenC.balanceOf(address(vault)), 100 ether);
        assertEq(tokenD.balanceOf(address(vault)), 100 ether);
    }

    function testCanPerformSwapWithCleanup() public {
        ERC20 tokenA = new ERC20("Token A", "TOKA", 18);
        ERC20 tokenB = new ERC20("Token B", "TOKB", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);

        // Get some Token B
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenB),
            0.2 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                0.2 ether,
                tokenB,
                0.2 ether
            ),
            true
        );

        tokenA.mint(address(this), 1 ether);
        tokenA.approve(address(executor), 1 ether);

        executor.swapAndCompleteBridgeTokens(
            "",
            swapData,
            address(tokenA),
            payable(address(0xb33f))
        );
        assertEq(tokenB.balanceOf(address(0xb33f)), 0.2 ether);
        assertEq(tokenA.balanceOf(address(0xb33f)), 0.8 ether);
    }

    function testCanPerformSameChainComplexSwap() public {
        ERC20 tokenA = new ERC20("Token A", "TOKA", 18);
        ERC20 tokenB = new ERC20("Token B", "TOKB", 18);
        ERC20 tokenC = new ERC20("Token C", "TOKC", 18);
        ERC20 tokenD = new ERC20("Token D", "TOKD", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](6);

        // Get some Token B
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenB),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                1_000 ether,
                tokenB,
                101 ether
            ),
            true
        );

        // Get some Token C
        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenC),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                1_000 ether,
                tokenC,
                102 ether
            ),
            false
        );

        // Get some Token D
        swapData[2] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenD),
            1_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                tokenA,
                1_000 ether,
                tokenD,
                103 ether
            ),
            false
        );

        // Deposit Token B
        swapData[3] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenB),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenB),
                100 ether
            ),
            true
        );

        // Deposit Token C
        swapData[4] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenC),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenC),
                100 ether
            ),
            true
        );

        // Deposit Token D
        swapData[5] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenD),
            address(0),
            100 ether,
            abi.encodeWithSelector(
                vault.deposit.selector,
                address(tokenD),
                100 ether
            ),
            true
        );

        tokenA.mint(address(this), 4_000 ether);
        tokenA.mint(address(executor), 10 ether); // Add some accidental tokens to contract
        tokenA.approve(address(erc20Proxy), 4_000 ether);

        executor.swapAndExecute(
            "",
            swapData,
            address(tokenA),
            payable(address(0xb33f)),
            4_000 ether
        );

        assertEq(tokenA.balanceOf(address(executor)), 10 ether); // Pre execution balance
        assertEq(tokenA.balanceOf(address(0xb33f)), 1_000 ether);
        assertEq(tokenB.balanceOf(address(0xb33f)), 1 ether); // Positive slippage
        assertEq(tokenC.balanceOf(address(0xb33f)), 2 ether); // Positive slippage
        assertEq(tokenD.balanceOf(address(0xb33f)), 3 ether); // Positive slippage
        assertEq(tokenB.balanceOf(address(vault)), 100 ether);
        assertEq(tokenC.balanceOf(address(vault)), 100 ether);
        assertEq(tokenD.balanceOf(address(vault)), 100 ether);
    }

    function testFailWhenCallingERC20ProxyDirectly() public {
        ERC20 tokenA = new ERC20("Token A", "TOKA", 18);
        ERC20 tokenB = new ERC20("Token B", "TOKB", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);

        // Get some Token B
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenB),
            0.2 ether,
            abi.encodeWithSelector(
                erc20Proxy.transferFrom.selector,
                address(tokenA),
                address(this),
                address(0xb33f),
                0.5 ether
            ),
            true
        );
        tokenA.mint(address(this), 1 ether);
        tokenA.approve(address(erc20Proxy), 1 ether);

        executor.swapAndExecute(
            "",
            swapData,
            address(tokenA),
            payable(address(0xb33f)),
            0.2 ether
        );
    }
}
