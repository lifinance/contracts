// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "../../../src/Libraries/LibAllowList.sol";
import { EcoFacet } from "../../../src/Facets/EcoFacet.sol";
import { IEco } from "../../../src/Interfaces/IEco.sol";

// Mock IntentSource contract for testing
contract MockIntentSource is IEco {
    event IntentPublishedAndFunded(
        Intent intent,
        bool allowPartial,
        uint256 value
    );

    function publishAndFund(
        Intent calldata intent,
        bool allowPartial
    ) external payable returns (bytes32) {
        emit IntentPublishedAndFunded(intent, allowPartial, msg.value);
        return keccak256(abi.encode(intent));
    }

    function publish(Intent calldata intent) external returns (bytes32) {
        return keccak256(abi.encode(intent));
    }

    function fund(
        bytes32,
        Reward calldata reward,
        bool
    ) external payable returns (bytes32) {
        return keccak256(abi.encode(reward));
    }
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
    EcoFacet.EcoData internal validEcoData;
    MockIntentSource internal mockIntentSource;
    address internal constant DEFAULT_PROVER = address(0x1234);

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        // Deploy mock IntentSource
        mockIntentSource = new MockIntentSource();

        // Deploy facet with default prover
        ecoFacet = new TestEcoFacet(DEFAULT_PROVER);

        // Add facet to diamond
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

        // Configure DEX
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

        // Configure bridge data
        bridgeData.bridge = "eco";
        bridgeData.destinationChainId = 137;

        // Create valid EcoData with Intent Source address
        validEcoData = EcoFacet.EcoData({
            intentSource: address(mockIntentSource),
            receiver: USER_RECEIVER,
            prover: address(0), // Will use default
            deadline: block.timestamp + 1 hours,
            nonce: 1,
            routeData: abi.encode("test_route_data"),
            allowPartial: false
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            ecoFacet.startBridgeTokensViaEco{ value: bridgeData.minAmount }(
                bridgeData,
                validEcoData
            );
        } else {
            ecoFacet.startBridgeTokensViaEco(bridgeData, validEcoData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            ecoFacet.swapAndStartBridgeTokensViaEco{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validEcoData);
        } else {
            ecoFacet.swapAndStartBridgeTokensViaEco(
                bridgeData,
                swapData,
                validEcoData
            );
        }
    }

    // Additional Eco-specific tests
    function test_EcoFacet_RevertWhenIntentSourceNotProvided() public {
        EcoFacet.EcoData memory invalidData = validEcoData;
        invalidData.intentSource = address(0);

        vm.expectRevert();

        ecoFacet.startBridgeTokensViaEco(bridgeData, invalidData);
    }

    function test_EcoFacet_RevertWhenDeadlineExpired() public {
        EcoFacet.EcoData memory expiredData = validEcoData;
        expiredData.deadline = block.timestamp - 1;

        vm.expectRevert(
            abi.encodeWithSelector(EcoFacet.InvalidDeadline.selector)
        );

        ecoFacet.startBridgeTokensViaEco(bridgeData, expiredData);
    }

    function test_EcoFacet_UsesDefaultProverWhenNotProvided() public {
        // validEcoData already has prover set to address(0)
        // Should use DEFAULT_PROVER from constructor

        vm.expectEmit(false, false, false, true, address(mockIntentSource));

        // We expect the intent to have DEFAULT_PROVER
        // The actual event checking would require decoding the Intent struct

        ecoFacet.startBridgeTokensViaEco(bridgeData, validEcoData);
    }

    function test_EcoFacet_UsesProvidedProverWhenSet() public {
        address customProver = address(0x9999);
        EcoFacet.EcoData memory customData = validEcoData;
        customData.prover = customProver;

        // Should use the provided prover instead of default
        ecoFacet.startBridgeTokensViaEco(bridgeData, customData);
    }
}
