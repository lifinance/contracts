// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../utils/DiamondTest.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";

/// @dev Diamond-compatible facet with the whitelist test helpers.
contract TestSupersetFacetHub is SupersetFacet, TestWhitelistManagerBase {
    constructor(address _poolManager) SupersetFacet(_poolManager) {}
}

/// @title SupersetFacet hub same-chain (DEX) fork test
/// @notice Exercises the atomic hub `exactInput` path against Superset's *real*
///         deployed `HubPoolManager` on Arbitrum One. Unlike the spoke
///         `multiHopSwap` path (which only escrows + emits a LayerZero message),
///         hub same-chain executes the Uniswap-V3 swap synchronously in the same
///         transaction, so this is the only branch whose on-chain behaviour can
///         be proven without waiting on an async LayerZero delivery.
/// @dev Complements the mock-based `test_CanBridgeSameChainOnHub` in
///      `SupersetFacet.t.sol`: that test pins the ABI wiring, this one confirms
///      the wiring works end-to-end against the live contract + real liquidity.
contract SupersetFacetHubForkTest is Test, DiamondTest, ILiFi {
    // --- Real Superset Arbitrum deployment (see config/superset.json) ---
    address internal constant HUB_POOL_MANAGER =
        0xcC687ed9155F5e49719D5f3147F79FD5F177961c;

    // --- Arbitrum local tokens (resolved from the hub OmniTokenAddressBook) ---
    // OmniToken id 2 -> USDC (native), id 4 -> tGBP.
    address internal constant USDC_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant TGBP_ARBITRUM =
        0x27f6c8289550fCE67f6B50BeD1F519966aFE5287;
    uint256 internal constant OMNI_ID_USDC = 2;
    uint256 internal constant OMNI_ID_TGBP = 4;
    // Uniswap-V3 fee tier with live USDC->tGBP liquidity at the pinned block.
    uint24 internal constant POOL_FEE = 500;

    // Accounts (mirror TestBase).
    address internal constant USER_SENDER = address(0xabc123456);
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER =
        0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;

    uint256 internal constant AMOUNT_IN = 100e6; // 100 USDC (6 decimals)

    LiFiDiamond internal diamond;
    TestSupersetFacetHub internal supersetFacet;
    IERC20 internal usdc;
    IERC20 internal tgbp;

    function setUp() public {
        // Pin a block where the USDC->tGBP mirror pool is liquid (100 USDC quotes
        // ~74.8 tGBP via the hub local-tokens quoter). Requires an archive-capable
        // `ETH_NODE_URI_ARBITRUM`.
        vm.createSelectFork(vm.envString("ETH_NODE_URI_ARBITRUM"), 488129002);

        // Sanity: the facet must be deployed on the hub chain for `IS_HUB`.
        assertEq(block.chainid, 42161, "fork must be Arbitrum One");

        usdc = IERC20(USDC_ARBITRUM);
        tgbp = IERC20(TGBP_ARBITRUM);

        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);

        supersetFacet = new TestSupersetFacetHub(HUB_POOL_MANAGER);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = supersetFacet.startBridgeTokensViaSuperset.selector;
        addFacet(diamond, address(supersetFacet), selectors);
        supersetFacet = TestSupersetFacetHub(payable(address(diamond)));

        vm.label(HUB_POOL_MANAGER, "Superset.HubPoolManager");
        vm.label(USDC_ARBITRUM, "USDC");
        vm.label(TGBP_ARBITRUM, "tGBP");
        vm.label(address(diamond), "LiFiDiamond");
    }

    /// @notice Hub same-chain DEX swap: 100 USDC -> tGBP via the real
    ///         `HubPoolManager.exactInput`, delivered atomically to the receiver.
    function test_HubSameChain_ExactInput_RealPoolManager() public {
        deal(USDC_ARBITRUM, USER_SENDER, AMOUNT_IN);

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: keccak256("superset-hub-samechain"),
            bridge: "superset",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ARBITRUM,
            receiver: USER_RECEIVER,
            minAmount: AMOUNT_IN,
            // Same-chain (DEX) route: destination == source (Arbitrum).
            destinationChainId: 42161,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        // amountOutMin is a safe floor below the ~74.8 tGBP live quote for 100 USDC.
        uint256 amountOutMin = 74e18;
        SupersetFacet.SupersetData memory supersetData = SupersetFacet
            .SupersetData({
                // omniId(USDC) || fee(500) || omniId(tGBP); resolved to local
                // addresses on-chain by the facet before calling `exactInput`.
                path: abi.encodePacked(
                    bytes32(OMNI_ID_USDC),
                    bytes3(POOL_FEE),
                    bytes32(OMNI_ID_TGBP)
                ),
                amountOutMin: amountOutMin,
                refundAddress: USER_SENDER,
                // Hub same-chain (`exactInput`) is atomic and ignores fallbackEoA.
                fallbackEoA: address(0),
                deadline: block.timestamp + 1 hours,
                // toEid / options / lzFee are unused on the hub same-chain branch.
                toEid: 0,
                options: "",
                lzFee: 0
            });

        vm.startPrank(USER_SENDER);
        usdc.approve(address(supersetFacet), AMOUNT_IN);

        uint256 senderUsdcBefore = usdc.balanceOf(USER_SENDER);
        uint256 receiverTgbpBefore = tgbp.balanceOf(USER_RECEIVER);

        vm.expectEmit(true, true, true, true, address(supersetFacet));
        emit LiFiTransferStarted(bridgeData);

        supersetFacet.startBridgeTokensViaSuperset(bridgeData, supersetData);
        vm.stopPrank();

        // Input fully consumed from the sender.
        assertEq(
            usdc.balanceOf(USER_SENDER),
            senderUsdcBefore - AMOUNT_IN,
            "sender USDC not debited by amountIn"
        );

        // Output delivered atomically to the receiver, honouring the slippage floor.
        uint256 received = tgbp.balanceOf(USER_RECEIVER) - receiverTgbpBefore;
        assertGe(
            received,
            amountOutMin,
            "receiver got less than amountOutMin"
        );
        // Bound above the quote so a silent routing change is caught.
        assertLe(received, 76e18, "output above expected range");

        // No token dust should be stranded on the diamond.
        assertEq(
            usdc.balanceOf(address(supersetFacet)),
            0,
            "USDC stranded on diamond"
        );
        assertEq(
            tgbp.balanceOf(address(supersetFacet)),
            0,
            "tGBP stranded on diamond"
        );
    }
}
