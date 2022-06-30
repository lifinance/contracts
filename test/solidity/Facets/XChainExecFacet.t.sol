// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.13;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { XChainExecFacet } from "lifi/Facets/XChainExecFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { TestAMM } from "../utils/TestAMM.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

// Stub CBridgeFacet Contract
contract TestXChainExecFacet is XChainExecFacet {
    function addDex(address _dex) external {
        mapping(address => bool) storage dexAllowlist = appStorage.dexAllowlist;

        if (dexAllowlist[_dex]) {
            return;
        }

        dexAllowlist[_dex] = true;
        appStorage.dexs.push(_dex);
    }

    function setFunctionApprovalBySignature(bytes32 signature) external {
        mapping(bytes32 => bool) storage dexFuncSignatureAllowList = appStorage.dexFuncSignatureAllowList;
        if (dexFuncSignatureAllowList[signature]) return;
        dexFuncSignatureAllowList[signature] = true;
    }
}

// Stub Vault Contract
contract Vault {
    function deposit(address token, uint256 amount) external {
        ERC20(token).transferFrom(msg.sender, address(this), amount);
    }
}

contract XChainExecFacetTest is DSTest, DiamondTest {
    ILiFi.LiFiData internal lifiData = ILiFi.LiFiData("", "", address(0), address(0), address(0), address(0), 0, 0);

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestXChainExecFacet internal xChain;
    TestAMM internal amm;
    Vault internal vault;

    function setUp() public {
        diamond = createDiamond();
        xChain = new TestXChainExecFacet();
        amm = new TestAMM();
        vault = new Vault();

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = xChain.swapAndCompleteBridgeTokens.selector;
        functionSelectors[1] = xChain.addDex.selector;
        functionSelectors[2] = xChain.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(xChain), functionSelectors);

        xChain = TestXChainExecFacet(address(diamond));
        xChain.addDex(address(amm));
        xChain.addDex(address(vault));
        xChain.setFunctionApprovalBySignature(bytes32(amm.swap.selector));
        xChain.setFunctionApprovalBySignature(bytes32(vault.deposit.selector));
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
            abi.encodeWithSelector(amm.swap.selector, tokenA, 1_000 ether, tokenB, 101 ether)
        );

        // Get some Token C
        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenC),
            1_000 ether,
            abi.encodeWithSelector(amm.swap.selector, tokenA, 1_000 ether, tokenC, 102 ether)
        );

        // Get some Token D
        swapData[2] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(tokenA),
            address(tokenD),
            1_000 ether,
            abi.encodeWithSelector(amm.swap.selector, tokenA, 1_000 ether, tokenD, 103 ether)
        );

        // Deposit Token B
        swapData[3] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenB),
            address(0),
            100 ether,
            abi.encodeWithSelector(vault.deposit.selector, address(tokenB), 100 ether)
        );

        // Deposit Token C
        swapData[4] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenC),
            address(0),
            100 ether,
            abi.encodeWithSelector(vault.deposit.selector, address(tokenC), 100 ether)
        );

        // Deposit Token D
        swapData[5] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenD),
            address(0),
            100 ether,
            abi.encodeWithSelector(vault.deposit.selector, address(tokenD), 100 ether)
        );

        tokenA.mint(address(this), 4_000 ether);
        tokenA.mint(address(xChain), 10 ether); // Add some accidental tokens to contract
        tokenA.approve(address(xChain), 4_000 ether);

        xChain.swapAndCompleteBridgeTokens(lifiData, swapData, address(tokenA), payable(address(0xb33f)));

        assertEq(tokenA.balanceOf(address(xChain)), 10 ether); // Pre execution balance
        assertEq(tokenA.balanceOf(address(0xb33f)), 1_000 ether);
        assertEq(tokenB.balanceOf(address(0xb33f)), 1 ether); // Positive slippage
        assertEq(tokenC.balanceOf(address(0xb33f)), 2 ether); // Positive slippage
        assertEq(tokenD.balanceOf(address(0xb33f)), 3 ether); // Positive slippage
        assertEq(tokenB.balanceOf(address(vault)), 100 ether);
        assertEq(tokenC.balanceOf(address(vault)), 100 ether);
        assertEq(tokenD.balanceOf(address(vault)), 100 ether);
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
            abi.encodeWithSelector(amm.swap.selector, address(0), 1_000 ether, tokenB, 101 ether)
        );

        // Get some Token C
        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(0),
            address(tokenC),
            1_000 ether,
            abi.encodeWithSelector(amm.swap.selector, address(0), 1_000 ether, tokenC, 102 ether)
        );

        // Get some Token D
        swapData[2] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(0),
            address(tokenD),
            1_000 ether,
            abi.encodeWithSelector(amm.swap.selector, address(0), 1_000 ether, tokenD, 103 ether)
        );

        // Deposit Token B
        swapData[3] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenB),
            address(0),
            100 ether,
            abi.encodeWithSelector(vault.deposit.selector, address(tokenB), 100 ether)
        );

        // Deposit Token C
        swapData[4] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenC),
            address(0),
            100 ether,
            abi.encodeWithSelector(vault.deposit.selector, address(tokenC), 100 ether)
        );

        // Deposit Token D
        swapData[5] = LibSwap.SwapData(
            address(vault),
            address(vault),
            address(tokenD),
            address(0),
            100 ether,
            abi.encodeWithSelector(vault.deposit.selector, address(tokenD), 100 ether)
        );

        vm.deal(address(xChain), 10 ether);

        xChain.swapAndCompleteBridgeTokens{ value: 4_000 ether }(
            lifiData,
            swapData,
            address(0),
            payable(address(0xb33f))
        );

        assertEq(address(xChain).balance, 10 ether); // Pre execution balance
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
            abi.encodeWithSelector(amm.swap.selector, tokenA, 0.2 ether, tokenB, 0.2 ether)
        );

        tokenA.mint(address(this), 1 ether);
        tokenA.approve(address(xChain), 1 ether);

        xChain.swapAndCompleteBridgeTokens(lifiData, swapData, address(tokenA), payable(address(0xb33f)));
        assertEq(tokenB.balanceOf(address(0xb33f)), 0.2 ether);
        assertEq(tokenA.balanceOf(address(0xb33f)), 0.8 ether);
    }
}
