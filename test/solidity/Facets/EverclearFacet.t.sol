// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { MessageHashUtils } from "src/Utils/MessageHashUtils.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { EverclearFacet } from "lifi/Facets/EverclearFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { IEverclearFeeAdapter } from "lifi/Interfaces/IEverclearFeeAdapter.sol";

// Stub EverclearFacet Contract
contract TestEverclearFacet is EverclearFacet {
    constructor(
        address _example
    ) EverclearFacet(_example) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EverclearFacetTest is TestBaseFacet {
    using MessageHashUtils for bytes32;

    EverclearFacet.EverclearData internal validEverclearData;
    TestEverclearFacet internal everclearFacet;
    IEverclearFeeAdapter internal feeAdapter = IEverclearFeeAdapter(address(0x15a7cA97D1ed168fB34a4055CEFa2E2f9Bdb6C75));

    uint256 internal signerPrivateKey;
    address internal signerAddress;


    function setUp() public {
        customBlockNumberForForking = 23433940;
        initTestBase();

        signerPrivateKey = 0x1234;
        signerAddress = vm.addr(signerPrivateKey);

        everclearFacet = new TestEverclearFacet(address(feeAdapter));
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = everclearFacet.startBridgeTokensViaEverclear.selector;
        functionSelectors[1] = everclearFacet
            .swapAndStartBridgeTokensViaEverclear
            .selector;
        functionSelectors[2] = everclearFacet.addDex.selector;
        functionSelectors[3] = everclearFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(everclearFacet), functionSelectors);
        everclearFacet = TestEverclearFacet(address(diamond));
        everclearFacet.addDex(ADDRESS_UNISWAP);
        everclearFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        everclearFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        everclearFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(everclearFacet), "EverclearFacet");

        uint256 fee = 10000;
        uint256 deadline = block.timestamp + 10000;

        deal(ADDRESS_USDC, address(USER_SENDER), defaultUSDCAmount + fee);

        vm.startPrank(feeAdapter.owner());
        feeAdapter.updateFeeSigner(signerAddress);
        vm.stopPrank();

        // adjust bridgeData
        bridgeData.bridge = "everclear";
        bridgeData.destinationChainId = 42161;
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

    // 3. Hash the data that needs to be signed
    // The FeeAdapter signs: abi.encode(_tokenFee, _nativeFee, _inputAsset, _deadline)
    bytes32 messageHash = keccak256(
        abi.encode(fee, 0, bridgeData.sendingAssetId, deadline)
    );
    bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

    // 4. Sign the hash
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(
        signerPrivateKey,
        ethSignedMessageHash
    );
    bytes memory signature = abi.encodePacked(r, s, v);

        // produce valid EverclearData
        validEverclearData = EverclearFacet.EverclearData({
            receiverAddress: bytes32(bytes20(uint160(USER_RECEIVER))),
            outputAsset: bytes32(bytes20(uint160(ADDRESS_USDC_BASE))),
            maxFee: 10000,
            ttl: 10000,
            data: "",
            fee: fee,
            deadline: deadline,
            sig: signature
        });
    }

    // All facet test files inherit from `utils/TestBaseFacet.sol` and require the following method overrides:
    // - function initiateBridgeTxWithFacet(bool isNative)
    // - function initiateSwapAndBridgeTxWithFacet(bool isNative)
    //
    // These methods are used to run the following tests which must pass:
    // - testBase_CanBridgeNativeTokens()
    // - testBase_CanBridgeTokens()
    // - testBase_CanBridgeTokens_fuzzed(uint256)
    // - testBase_CanSwapAndBridgeNativeTokens()
    // - testBase_CanSwapAndBridgeTokens()
    // - testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
    // - testBase_Revert_BridgeToSameChainId()
    // - testBase_Revert_BridgeWithInvalidAmount()
    // - testBase_Revert_BridgeWithInvalidDestinationCallFlag()
    // - testBase_Revert_BridgeWithInvalidReceiverAddress()
    // - testBase_Revert_CallBridgeOnlyFunctionWithSourceSwapFlag()
    // - testBase_Revert_CallerHasInsufficientFunds()
    // - testBase_Revert_SwapAndBridgeToSameChainId()
    // - testBase_Revert_SwapAndBridgeWithInvalidAmount()
    // - testBase_Revert_SwapAndBridgeWithInvalidSwapData()
    // 
    // In some cases it doesn't make sense to have all tests. For example the bridge may not support native tokens.
    // In that case you can override the test method and leave it empty. For example:
    // 
    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }
    
    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanBridgeTokens222()
        public
        virtual
        assertBalanceChange(
            ADDRESS_USDC,
            USER_SENDER,
            -int256(defaultUSDCAmount)
        )
        assertBalanceChange(ADDRESS_USDC, USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(address(everclearFacet), bridgeData.minAmount + validEverclearData.fee);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(everclearFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            everclearFacet.startBridgeTokensViaEverclear{
                value: bridgeData.minAmount
            }(bridgeData, validEverclearData);
        } else {
            everclearFacet.startBridgeTokensViaEverclear(
                bridgeData,
                validEverclearData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            everclearFacet.swapAndStartBridgeTokensViaEverclear{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validEverclearData);
        } else {
            everclearFacet.swapAndStartBridgeTokensViaEverclear(
                bridgeData,
                swapData,
                validEverclearData
            );
        }
    }
}
