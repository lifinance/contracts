// SPDX-License-Identifier: Unlicense
pragma solidity >=0.8.0;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { console } from "../utils/Console.sol";

contract TestFacet {
    constructor() {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

//common utilities for forge tests
abstract contract TestBase is DSTest, DiamondTest {
    address private _facetAddress;
    uint64 internal currentTxId;
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    bytes32 internal nextUser = keccak256(abi.encodePacked("user address"));
    UniswapV2Router02 internal uniswap;
    ERC20 internal usdc;
    ERC20 internal dai;
    LiFiDiamond internal diamond;
    ILiFi.BridgeData internal bridgeData;
    LibSwap.SwapData[] internal swapData;

    // Contract addresses (ETH only)
    address internal constant ADDRESS_UNISWAP = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address internal constant ADDRESS_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant ADDRESS_DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant ADDRESS_WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // User accounts (Whales: ETH only)
    address internal constant USER_DEPLOYER = 0xb4c79daB8f259C7Aee6E5b2Aa729821864227e84;
    address internal constant USER_SENDER = address(0xabc123456);
    address internal constant USER_RECEIVER = address(0xabc654321); //! required?
    address internal constant USER_REFUND = address(0xabc654321); //! required?
    address internal constant USER_USDC_WHALE = 0x72A53cDBBcc1b9efa39c834A540550e23463AAcB;
    address internal constant USER_DAI_WHALE = 0x5D38B4e4783E34e2301A2a36c39a03c45798C4dD;

    modifier executeAsDeployer() {
        vm.prank(USER_DEPLOYER);
        _;
    }

    function setFacetAddressInTestBase(address facetAddress) internal {
        _facetAddress = facetAddress;
    }

    function initTestBase() internal {
        // activate fork
        fork();

        // fill user accounts with starting balance
        uniswap = UniswapV2Router02(ADDRESS_UNISWAP);
        usdc = ERC20(ADDRESS_USDC);
        dai = ERC20(ADDRESS_DAI);

        // deploy & configure diamond
        diamond = createDiamond();

        //! this part cannot be moved to testhelper contract since it requires the custom
        //! contract type of the to-be-created test case....any ideas how to move this here?
        // bytes4[] memory functionSelectors = new bytes4[](4);
        // functionSelectors[0] = startBridgeSelector;
        // functionSelectors[1] = swapAndStartBridgeSelector;
        // functionSelectors[2] = TestFacet.addDex.selector;
        // functionSelectors[3] = TestFacet.setFunctionApprovalBySignature.selector;

        // cBridge = TestCBridgeFacet(address(diamond));
        // cBridge.addDex(address(uniswap));
        // cBridge.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
    }

    //! CHALLENGES FOR LEVEL2 (Standard tests that can easily be executed from test contracts):
    //! - move setup of diamond into TestBase (issue: dont have the contract type and its selectors of the TestBridgeFace)
    //! - move swapData preparation into TestBase

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = vm.envUint("FORK_NUMBER");
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setDefaultBridgeData() internal {
        bridgeData = ILiFi.BridgeData(
            "",
            "cbridge",
            "",
            address(0),
            ADDRESS_USDC,
            USER_RECEIVER,
            100 * 10**usdc.decimals(),
            100,
            false,
            false
        );
    }

    function setDefaultSwapDataSingleDAItoUSDC() internal {
        // Swap DAI -> USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = 100 * 10**usdc.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    amountOut,
                    path,
                    _facetAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function runDefaultTests() internal {
        testBaseCanBridgeTokens();
        testBaseCanSwapAndBridgeTokens();
    }

    function testBaseCanBridgeTokens() internal {
        vm.startPrank(USER_USDC_WHALE);
        // prepare bridgeData
        setDefaultBridgeData();

        // approval
        usdc.approve(_facetAddress, bridgeData.minAmount);
        initiateBridgeTxWithFacet();
        vm.stopPrank();
    }

    function testBaseCanSwapAndBridgeTokens() internal {
        vm.startPrank(USER_DAI_WHALE);

        // prepare bridgeData
        setDefaultBridgeData();
        bridgeData.hasSourceSwaps = true;

        // prepare swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetAddress, swapData[0].fromAmount);

        initiateSwapAndBridgeTxWithFacet();
    }

    //! NEXT STEPS
    //! - add native test cases and support in Facet
    //! - add balance checks in standard test cases (needed due to event check?)
    //! - can we check more events?

    //#region abstract functions

    // this function must be implemented by the facet test contract
    // it will contain the logic to:
    // a) prepare the facet-specific data
    // b) call the correct function selectors (as they differ for each facet)
    function initiateBridgeTxWithFacet() internal virtual;

    function initiateSwapAndBridgeTxWithFacet() internal virtual;

    function testRunDefaultTests() public virtual;

    //#endregion

    //#region existing

    function getNextUserAddress() external returns (address payable) {
        //bytes32 to address conversion
        address payable user = payable(address(uint160(uint256(nextUser))));
        nextUser = keccak256(abi.encodePacked(nextUser));
        return user;
    }

    //create users with 100 ether balance
    function createUsers(uint256 userNum) external returns (address payable[] memory) {
        address payable[] memory users = new address payable[](userNum);
        for (uint256 i = 0; i < userNum; i++) {
            address payable user = this.getNextUserAddress();
            vm.deal(user, 100 ether);
            users[i] = user;
        }
        return users;
    }

    //move block.number forward by a given number of blocks
    function mineBlocks(uint256 numBlocks) external {
        uint256 targetBlock = block.number + numBlocks;
        vm.roll(targetBlock);
    }
    //#endregion
}
