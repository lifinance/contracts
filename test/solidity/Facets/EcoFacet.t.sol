// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";
import { EcoFacet } from "../../../src/Facets/EcoFacet.sol";
import { IEco } from "../../../src/Interfaces/IEco.sol";
import { InvalidContract, InvalidProver, InvalidDeadline } from "../../../src/Errors/GenericErrors.sol";

// Mock Portal contract for testing
contract MockPortal is IEco {
    event IntentFunded(
        uint64 destination,
        bytes32 routeHash,
        Reward reward,
        bool allowPartial,
        uint256 value
    );

    function publish(
        uint64 destination,
        Route calldata route,
        Reward calldata reward
    ) external pure returns (bytes32 intentHash, address vault) {
        intentHash = keccak256(
            abi.encode(
                destination,
                keccak256(abi.encode(route)),
                keccak256(abi.encode(reward))
            )
        );
        vault = address(uint160(uint256(intentHash)));
        return (intentHash, vault);
    }

    function fund(
        uint64 destination,
        bytes32 routeHash,
        Reward calldata reward,
        bool allowPartial
    ) external payable returns (bytes32) {
        emit IntentFunded(
            destination,
            routeHash,
            reward,
            allowPartial,
            msg.value
        );
        return keccak256(abi.encode(destination, routeHash, reward));
    }

    function fulfill(
        bytes32,
        Route calldata,
        bytes32,
        address
    ) external pure returns (bytes[] memory results) {
        results = new bytes[](0);
        return results;
    }

    function prove(
        address,
        uint64,
        bytes32[] calldata,
        bytes calldata
    ) external {}

    function withdraw(uint64, bytes32, Reward calldata) external {}

    function refund(uint64, bytes32, Reward calldata) external {}
}

// Test contract wrapper
contract TestEcoFacet is EcoFacet {
    constructor(address _defaultProver) EcoFacet(_defaultProver) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EcoFacetTest is TestBaseFacet {
    TestEcoFacet internal ecoFacet;
    MockPortal internal mockPortal;
    address internal defaultProver =
        address(0x1234567890123456789012345678901234567890);

    function setUp() public {
        initTestBase();

        // Deploy contracts
        ecoFacet = new TestEcoFacet(defaultProver);
        mockPortal = new MockPortal();

        // Add facet to diamond
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = ecoFacet.startBridgeTokensViaEco.selector;
        functionSelectors[1] = ecoFacet
            .swapAndStartBridgeTokensViaEco
            .selector;
        functionSelectors[2] = ecoFacet.addDex.selector;
        functionSelectors[3] = ecoFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = ecoFacet.DEFAULT_PROVER.selector;

        addFacet(diamond, address(ecoFacet), functionSelectors);
        ecoFacet = TestEcoFacet(address(diamond));

        // Setup facet
        ecoFacet.addDex(address(mockPortal));
        ecoFacet.addDex(address(uniswap));
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

        // Setup initial bridge data
        setDefaultBridgeData();
        bridgeData.bridge = "eco";
        bridgeData.destinationChainId = 137;

        // Labels for debugging
        vm.label(address(ecoFacet), "EcoFacet");
        vm.label(address(mockPortal), "MockPortal");
        vm.label(defaultProver, "DefaultProver");
    }

    function getDefaultEcoData()
        internal
        view
        returns (EcoFacet.EcoData memory)
    {
        IEco.Call[] memory calls = new IEco.Call[](0);

        return
            EcoFacet.EcoData({
                portal: address(mockPortal),
                destinationPortal: address(
                    0x9876543210987654321098765432109876543210
                ),
                prover: address(0),
                routeDeadline: uint64(block.timestamp + 1 hours),
                rewardDeadline: uint64(block.timestamp + 2 hours),
                salt: bytes32(uint256(1)),
                calls: calls,
                allowPartial: false
            });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        if (isNative) {
            ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
                bridgeData,
                ecoData
            );
        } else {
            ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        if (isNative) {
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, ecoData);
        } else {
            ecoFacet.swapAndStartBridgeTokensViaEco(
                bridgeData,
                swapData,
                ecoData
            );
        }
    }

    // Custom tests

    function test_CanBridgeNativeTokensWithCustomProver() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.prover = address(0x999);
        vm.label(ecoData.prover, "CustomProver");

        // Set up for native token bridging
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        vm.startPrank(USER_SENDER);

        ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
            bridgeData,
            ecoData
        );

        vm.stopPrank();
    }

    function test_CanBridgeTokensWithDefaultProver() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.prover = address(0);
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 100 * 10 ** 6;

        deal(ADDRESS_USDC, USER_SENDER, bridgeData.minAmount);

        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        ecoFacet.startBridgeTokensViaEco(bridgeData, ecoData);

        vm.stopPrank();
    }

    function test_CanSwapAndBridgeWithProver() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.prover = address(0x888);
        vm.label(ecoData.prover, "SwapProver");

        setDefaultSwapDataSingleDAItoUSDC();
        bridgeData.hasSourceSwaps = true;

        vm.startPrank(USER_SENDER);
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        ecoFacet.swapAndStartBridgeTokensViaEco{
            value: swapData[0].fromAmount
        }(bridgeData, swapData, ecoData);

        vm.stopPrank();
    }

    function testRevert_FailsWithZeroPortal() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.portal = address(0);

        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidContract.selector);

        ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
            bridgeData,
            ecoData
        );

        vm.stopPrank();
    }

    function testRevert_FailsWithExpiredRouteDeadline() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.routeDeadline = uint64(block.timestamp);

        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidDeadline.selector);

        ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
            bridgeData,
            ecoData
        );

        vm.stopPrank();
    }

    function testRevert_FailsWithExpiredRewardDeadline() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.rewardDeadline = uint64(block.timestamp);

        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidDeadline.selector);

        ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
            bridgeData,
            ecoData
        );

        vm.stopPrank();
    }

    function testRevert_FailsWithZeroDefaultProver() public {
        vm.expectRevert(InvalidProver.selector);

        new TestEcoFacet(address(0));
    }

    function test_UsesDefaultProverWhenNotProvided() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        ecoData.prover = address(0);

        // Set up for native token bridging
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        vm.startPrank(USER_SENDER);

        ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
            bridgeData,
            ecoData
        );

        vm.stopPrank();

        assertEq(ecoFacet.DEFAULT_PROVER(), defaultProver);
    }

    function test_CanBridgeWithCallsData() public {
        EcoFacet.EcoData memory ecoData = getDefaultEcoData();
        IEco.Call[] memory calls = new IEco.Call[](1);
        calls[0] = IEco.Call({
            target: address(0x123),
            data: hex"abcdef",
            value: 0
        });
        ecoData.calls = calls;

        // Set up for native token bridging
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        vm.startPrank(USER_SENDER);

        ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
            bridgeData,
            ecoData
        );

        vm.stopPrank();
    }
}
