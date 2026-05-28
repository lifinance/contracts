// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";
import { ISupersetSpokePoolManager } from "lifi/Interfaces/ISupersetSpokePoolManager.sol";
import { ISupersetHubPoolManager } from "lifi/Interfaces/ISupersetHubPoolManager.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { InvalidConfig, NativeAssetNotSupported } from "lifi/Errors/GenericErrors.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

/// @dev Mock spoke that records the last call and pulls the input token, matching
///      Superset's real `multiHopSwapWithOutputChain` ABI on `develop` branch.
///      The first 32 bytes of `path` are treated as an omniTokenId; we use the
///      low 20 bytes as the local input token address. This mirrors how
///      Superset's `OmniTokenAddressBook` resolves omniTokenId → local token.
contract MockSupersetSpokePoolManager is ISupersetSpokePoolManager {
    using SafeERC20 for IERC20;

    struct Call {
        bytes path;
        uint256 amountIn;
        uint256 amountOutMin;
        address recipient;
        address refundAddress;
        address fallbackEoA;
        uint256 deadline;
        uint32 toEid;
        bytes options;
        uint256 lzFee;
        address inputToken;
    }

    Call public lastCall;

    function multiHopSwapWithOutputChain(
        bytes calldata _path,
        uint256 _amountIn,
        uint256 _amountOutMin,
        address _recipient,
        address _refundAddress,
        address _fallbackEoA,
        uint256 _deadline,
        uint32 _toEid,
        bytes calldata _options
    ) external payable override {
        address inputToken = address(uint160(uint256(bytes32(_path[0:32]))));

        IERC20(inputToken).safeTransferFrom(
            msg.sender,
            address(this),
            _amountIn
        );

        lastCall = Call({
            path: _path,
            amountIn: _amountIn,
            amountOutMin: _amountOutMin,
            recipient: _recipient,
            refundAddress: _refundAddress,
            fallbackEoA: _fallbackEoA,
            deadline: _deadline,
            toEid: _toEid,
            options: _options,
            lzFee: msg.value,
            inputToken: inputToken
        });
    }
}

/// @dev Hub-side mock — 7-arg ABI matching Superset's `HubPoolManager`.
contract MockSupersetHubPoolManager is ISupersetHubPoolManager {
    using SafeERC20 for IERC20;

    struct Call {
        bytes path;
        uint256 amountIn;
        uint256 amountOutMin;
        address recipient;
        address fallbackEoA;
        uint256 deadline;
        uint32 toEid;
        uint256 lzFee;
        address inputToken;
    }

    Call public lastCall;

    function multiHopSwapWithOutputChain(
        bytes calldata _path,
        uint256 _amountIn,
        uint256 _amountOutMin,
        address _recipient,
        address _fallbackEoA,
        uint256 _deadline,
        uint32 _toEid
    ) external payable override {
        address inputToken = address(uint160(uint256(bytes32(_path[0:32]))));

        IERC20(inputToken).safeTransferFrom(
            msg.sender,
            address(this),
            _amountIn
        );

        lastCall = Call({
            path: _path,
            amountIn: _amountIn,
            amountOutMin: _amountOutMin,
            recipient: _recipient,
            fallbackEoA: _fallbackEoA,
            deadline: _deadline,
            toEid: _toEid,
            lzFee: msg.value,
            inputToken: inputToken
        });
    }
}

contract TestSupersetFacet is SupersetFacet, TestWhitelistManagerBase {
    constructor(address _poolManager) SupersetFacet(_poolManager) {}
}

contract SupersetFacetTest is TestBaseFacet {
    // Arbitrary destination LayerZero EID (Unichain on mainnet in production).
    uint32 internal constant TO_EID = 30320;
    uint256 internal constant LZ_FEE = 0.005 ether;

    TestSupersetFacet internal supersetFacet;
    MockSupersetSpokePoolManager internal mockSpoke;
    SupersetFacet.SupersetData internal validSupersetData;

    function setUp() public {
        // Fork mainnet to inherit TestBase's default USDC etc.
        customBlockNumberForForking = 22000000;
        initTestBase();

        mockSpoke = new MockSupersetSpokePoolManager();
        supersetFacet = new TestSupersetFacet(address(mockSpoke));

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = supersetFacet
            .startBridgeTokensViaSuperset
            .selector;
        functionSelectors[1] = supersetFacet
            .swapAndStartBridgeTokensViaSuperset
            .selector;
        functionSelectors[2] = supersetFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(supersetFacet), functionSelectors);
        supersetFacet = TestSupersetFacet(payable(address(diamond)));
        supersetFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        supersetFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        supersetFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(supersetFacet), "SupersetFacet");

        bridgeData.bridge = "superset";
        bridgeData.destinationChainId = 130; // Unichain
        addToMessageValue = LZ_FEE;

        validSupersetData = SupersetFacet.SupersetData({
            // Embed the input token address in the first omniTokenId so the
            // mock can decode it. Fee tier 500, destination omniTokenId = 0x02.
            path: abi.encodePacked(
                bytes32(uint256(uint160(ADDRESS_USDC))),
                bytes3(uint24(500)),
                bytes32(uint256(2))
            ),
            amountOutMin: 1,
            amountOutMinPercent: 0.99e18,
            refundAddress: USER_SENDER,
            fallbackEoA: USER_REFUND,
            deadline: block.timestamp + 1 hours,
            toEid: TO_EID,
            options: hex"00",
            lzFee: LZ_FEE
        });
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        uint256 value = isNative
            ? swapData[0].fromAmount + validSupersetData.lzFee
            : validSupersetData.lzFee;

        supersetFacet.swapAndStartBridgeTokensViaSuperset{ value: value }(
            bridgeData,
            swapData,
            validSupersetData
        );
    }

    // --- Native source asset is intentionally unsupported (see facet NatSpec) ---

    function testBase_CanBridgeNativeTokens() public override {
        // Facet rejects native source asset; covered by `testRevert_NativeAssetNotSupported_Bridge`.
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // Facet rejects native source asset; covered by `testRevert_NativeAssetNotSupported_SwapAndBridge`.
    }

    // --- Constructor tests ---

    function test_CanDeployFacet() public {
        new SupersetFacet(address(mockSpoke));
    }

    function testRevert_WhenPoolManagerIsZero() public {
        vm.expectRevert(InvalidConfig.selector);

        new SupersetFacet(address(0));
    }

    function test_IsHubDerivedFromChainId() public {
        // Non-hub: deploy on the current fork chain (mainnet, id 1)
        SupersetFacet nonHubFacet = new SupersetFacet(address(mockSpoke));
        assertFalse(nonHubFacet.IS_HUB());

        // Hub: switch chainId to Arbitrum before constructing
        vm.chainId(42161);
        SupersetFacet hubFacet = new SupersetFacet(address(mockSpoke));
        assertTrue(hubFacet.IS_HUB());
    }

    // --- Validation tests ---

    function testRevert_NativeAssetNotSupported_Bridge() public {
        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.expectRevert(NativeAssetNotSupported.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: bridgeData.minAmount + validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_NativeAssetNotSupported_SwapAndBridge() public {
        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = address(0);
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = 1 ether;
        setDefaultSwapDataSingleDAItoETH();

        vm.expectRevert(NativeAssetNotSupported.selector);

        supersetFacet.swapAndStartBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, swapData, validSupersetData);
    }

    function testRevert_FallbackEoAIsContract() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);

        validSupersetData.fallbackEoA = address(mockSpoke);
        bridgeData.minAmount = defaultUSDCAmount;

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_InsufficientNativeValue() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;

        vm.expectRevert(SupersetFacet.InsufficientNativeValue.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee - 1
        }(bridgeData, validSupersetData);
    }

    function testRevert_RefundAddressIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.refundAddress = address(0);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_FallbackEoAIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.fallbackEoA = address(0);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function test_RefundsExcessNativeToRefundAddress() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.refundAddress = USER_REFUND;

        uint256 refundBalanceBefore = USER_REFUND.balance;
        uint256 excess = 0.01 ether;

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee + excess
        }(bridgeData, validSupersetData);

        assertEq(USER_REFUND.balance, refundBalanceBefore + excess);
    }

    // --- Forwarding tests ---

    function test_ForwardsBridgeArgsToSpoke() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);

        (
            ,
            uint256 amountIn,
            uint256 amountOutMin,
            address recipient,
            address refundAddress,
            address fallbackEoA,
            ,
            uint32 toEid,
            ,
            uint256 lzFee,
            address inputToken
        ) = mockSpoke.lastCall();

        assertEq(amountIn, defaultUSDCAmount);
        assertEq(amountOutMin, validSupersetData.amountOutMin);
        assertEq(recipient, bridgeData.receiver);
        assertEq(refundAddress, validSupersetData.refundAddress);
        assertEq(fallbackEoA, validSupersetData.fallbackEoA);
        assertEq(toEid, validSupersetData.toEid);
        assertEq(lzFee, validSupersetData.lzFee);
        assertEq(inputToken, ADDRESS_USDC);
    }

    function test_HubBranchForwardsArgsToHubAbi() public {
        // Switch the EVM chain id BEFORE construction so the facet's
        // IS_HUB immutable is set to true.
        vm.chainId(42161);

        MockSupersetHubPoolManager mockHub = new MockSupersetHubPoolManager();
        TestSupersetFacet hubFacet = new TestSupersetFacet(address(mockHub));

        vm.startPrank(USER_SENDER);
        usdc.approve(address(hubFacet), defaultUSDCAmount);

        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.bridge = "superset";
        // destinationChainId must differ from chain id 42161
        bridgeData.destinationChainId = 130;

        hubFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);

        (
            ,
            uint256 amountIn,
            ,
            address recipient,
            address fallbackEoA,
            ,
            uint32 toEid,
            uint256 lzFee,
            address inputToken
        ) = mockHub.lastCall();

        assertEq(amountIn, defaultUSDCAmount);
        assertEq(recipient, bridgeData.receiver);
        assertEq(fallbackEoA, validSupersetData.fallbackEoA);
        assertEq(toEid, validSupersetData.toEid);
        assertEq(lzFee, validSupersetData.lzFee);
        assertEq(inputToken, ADDRESS_USDC);
    }
}
