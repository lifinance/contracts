// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";
import { IEcoPortal } from "lifi/Interfaces/IEcoPortal.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

contract TestEcoFacet is EcoFacet {
    constructor(IEcoPortal _portal) EcoFacet(_portal) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EcoFacetTest is TestBaseFacet {
    TestEcoFacet internal ecoFacet;
    address internal constant PORTAL =
        0x90F0c8aCC1E083Bcb4F487f84FC349ae8d5e28D7;
    uint256 internal constant NATIVE_SOLVER_REWARD = 0.0001 ether;
    uint256 internal constant TOKEN_SOLVER_REWARD = 10 * 10 ** 6; // 10 USDC (6 decimals)

    function setUp() public {
        customBlockNumberForForking = 34694289;
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        initTestBase();
        addLiquidity(
            ADDRESS_USDC,
            ADDRESS_DAI,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals(),
            1000000 * 10 ** ERC20(ADDRESS_DAI).decimals()
        );
        addLiquidity(
            ADDRESS_WRAPPED_NATIVE,
            ADDRESS_USDC,
            100 ether,
            1000000 * 10 ** ERC20(ADDRESS_USDC).decimals()
        );

        ecoFacet = new TestEcoFacet(IEcoPortal(PORTAL));

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = ecoFacet.startBridgeTokensViaEco.selector;
        functionSelectors[1] = ecoFacet
            .swapAndStartBridgeTokensViaEco
            .selector;
        functionSelectors[2] = ecoFacet.addDex.selector;
        functionSelectors[3] = ecoFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(ecoFacet), functionSelectors);
        ecoFacet = TestEcoFacet(address(diamond));
        ecoFacet.addDex(ADDRESS_UNISWAP);
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        ecoFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(ecoFacet), "EcoFacet");

        bridgeData.bridge = "eco";
        bridgeData.destinationChainId = 10;

        // Set addToMessageValue for native token tests (ERC20 tests will override this)
        addToMessageValue = NATIVE_SOLVER_REWARD;
    }

    function getValidEcoData(
        bool isNative
    ) internal view returns (EcoFacet.EcoData memory) {
        IEcoPortal.Call[] memory emptyCalls = new IEcoPortal.Call[](0);

        // Calculate solver reward based on token type
        uint256 solverReward = isNative
            ? NATIVE_SOLVER_REWARD
            : TOKEN_SOLVER_REWARD;

        return
            EcoFacet.EcoData({
                receiverAddress: USER_RECEIVER,
                nonEVMReceiver: "",
                receivingAssetId: ADDRESS_USDC_OPTIMISM,
                salt: keccak256(abi.encode(block.timestamp)),
                routeDeadline: uint64(block.timestamp + 1 days),
                destinationPortal: PORTAL, // Same on OP,
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                solverReward: solverReward,
                destinationCalls: emptyCalls
            });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        EcoFacet.EcoData memory ecoData = getValidEcoData(isNative);

        if (isNative) {
            // For native: send bridge amount + native reward as msg.value
            ecoFacet.startBridgeTokensViaEco{
                value: bridgeData.minAmount + addToMessageValue
            }(bridgeData, ecoData);
        } else {
            // For ERC20: No msg.value needed, tokens already approved
            // The facet will pull minAmount + solverReward tokens
            ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        EcoFacet.EcoData memory ecoData = getValidEcoData(isNative);

        if (isNative) {
            // Swapping to native: send swap input + native reward
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: swapData[0].fromAmount + addToMessageValue
            }(bridgeData, swapData, ecoData);
        } else {
            // Swapping from native to ERC20: No additional msg.value needed
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, ecoData);
        }
    }

    function testRevert_WhenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(IEcoPortal(address(0)));
    }

    // Override base test to handle token rewards properly
    function testBase_CanBridgeTokens()
        public
        override
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount + TOKEN_SOLVER_REWARD) // User sends amount + reward
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval - need to approve total amount (bridge + reward)
        usdc.approve(
            _facetTestContractAddress,
            defaultUSDCAmount + TOKEN_SOLVER_REWARD
        );

        // prepare check for events - event will have the bridge amount, not total
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Override fuzzed test
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        // Get user's USDC balance
        uint256 userBalance = usdc.balanceOf(USER_SENDER);

        // Ensure amount is within valid range: needs to cover reward and not exceed balance
        vm.assume(
            amount > TOKEN_SOLVER_REWARD &&
                amount <= userBalance - TOKEN_SOLVER_REWARD
        );

        // Bridge amount is what we want to test
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        // Total amount includes reward
        uint256 totalAmount = amount + TOKEN_SOLVER_REWARD;

        vm.writeLine(logFilePath, vm.toString(amount));

        // approval for total amount
        usdc.approve(_facetTestContractAddress, totalAmount);

        // prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // Additional test to verify token rewards work correctly
    function test_BridgeERC20WithTokenReward() public {
        // Setup: User has USDC
        uint256 bridgeAmount = 100 * 10 ** 6; // 100 USDC to bridge
        uint256 rewardAmount = TOKEN_SOLVER_REWARD; // 10 USDC reward
        uint256 totalAmount = bridgeAmount + rewardAmount; // 110 USDC total

        vm.startPrank(USER_SENDER);
        usdc.approve(address(ecoFacet), totalAmount);

        bridgeData.minAmount = bridgeAmount;
        bridgeData.sendingAssetId = ADDRESS_USDC;

        EcoFacet.EcoData memory ecoData = getValidEcoData(false);

        uint256 userBalanceBefore = usdc.balanceOf(USER_SENDER);

        // Execute bridge
        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        // Verify that total amount (bridge + reward) was transferred from user
        assertEq(
            usdc.balanceOf(USER_SENDER),
            userBalanceBefore - totalAmount,
            "User should have sent total amount"
        );

        vm.stopPrank();
    }
}
