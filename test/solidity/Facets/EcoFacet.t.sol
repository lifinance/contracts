// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { EcoFacet } from "lifi/Facets/EcoFacet.sol";
import { IEcoPortal } from "lifi/Interfaces/IEcoPortal.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

contract MockEcoPortal is IEcoPortal {
    function publishAndFund(
        Intent calldata,
        bool
    ) external payable override returns (bytes32 intentHash, address vault) {
        intentHash = keccak256(abi.encode(block.timestamp, msg.sender));
        vault = address(this);
    }
}

contract TestEcoFacet is EcoFacet {
    constructor(IEcoPortal _intentSource) EcoFacet(_intentSource) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EcoFacetTest is TestBaseFacet {
    TestEcoFacet internal ecoFacet;
    MockEcoPortal internal mockPortal;

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        mockPortal = new MockEcoPortal();
        ecoFacet = new TestEcoFacet(IEcoPortal(address(mockPortal)));

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
        bridgeData.destinationChainId = 137;
    }

    function getValidEcoData()
        internal
        view
        returns (EcoFacet.EcoData memory)
    {
        IEcoPortal.Call[] memory emptyCalls = new IEcoPortal.Call[](0);

        return
            EcoFacet.EcoData({
                receiverAddress: USER_RECEIVER,
                nonEVMReceiver: "",
                receivingAssetId: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174, // Polygon USDC
                salt: keccak256(abi.encode(block.timestamp)),
                routeDeadline: uint64(block.timestamp + 1 days),
                destinationPortal: address(mockPortal),
                prover: address(0x1234),
                rewardDeadline: uint64(block.timestamp + 2 days),
                allowPartial: false,
                destinationCalls: emptyCalls
            });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        EcoFacet.EcoData memory validEcoData = getValidEcoData();

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
        EcoFacet.EcoData memory validEcoData = getValidEcoData();

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

    function testRevert_WhenUsingInvalidConfig() public {
        vm.expectRevert(InvalidConfig.selector);
        new EcoFacet(IEcoPortal(address(0)));
    }
}
