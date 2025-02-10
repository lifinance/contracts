// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { ChainflipFacet } from "lifi/Facets/ChainflipFacet.sol";
import { stdJson } from "forge-std/StdJson.sol";

using stdJson for string;

// Stub ChainflipFacet Contract
contract TestChainflipFacet is ChainflipFacet {
    constructor(address _chainflipVault) ChainflipFacet(_chainflipVault) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract ChainflipFacetTest is TestBaseFacet {
    ChainflipFacet.ChainflipData internal validChainflipData;
    TestChainflipFacet internal chainflipFacet;
    address internal CHAINFLIP_VAULT;

    function setUp() public {
        customBlockNumberForForking = 18277082;
        initTestBase();

        // Read chainflip vault address from config
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/chainflip.json"
        );
        string memory json = vm.readFile(path);
        CHAINFLIP_VAULT = json.readAddress(".mainnet.chainflipVault");
        vm.label(CHAINFLIP_VAULT, "Chainflip Vault");
        console.log("Chainflip Vault Address:", CHAINFLIP_VAULT);

        chainflipFacet = new TestChainflipFacet(CHAINFLIP_VAULT);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = chainflipFacet
            .startBridgeTokensViaChainflip
            .selector;
        functionSelectors[1] = chainflipFacet
            .swapAndStartBridgeTokensViaChainflip
            .selector;
        functionSelectors[2] = chainflipFacet.addDex.selector;
        functionSelectors[3] = chainflipFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(chainflipFacet), functionSelectors);
        chainflipFacet = TestChainflipFacet(address(diamond));
        chainflipFacet.addDex(ADDRESS_UNISWAP);
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        chainflipFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(chainflipFacet), "ChainflipFacet");

        // adjust bridgeData
        bridgeData.bridge = "chainflip";
        bridgeData.destinationChainId = 42161; // Arbitrum chain ID

        // produce valid ChainflipData
        validChainflipData = ChainflipFacet.ChainflipData({
            dstToken: 6,
            cfParameters: ""
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
    // function testBase_CanBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }
    //
    // function testBase_CanSwapAndBridgeNativeTokens() public override {
    //     // facet does not support bridging of native assets
    // }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            chainflipFacet.startBridgeTokensViaChainflip{
                value: bridgeData.minAmount
            }(bridgeData, validChainflipData);
        } else {
            chainflipFacet.startBridgeTokensViaChainflip(
                bridgeData,
                validChainflipData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            chainflipFacet.swapAndStartBridgeTokensViaChainflip{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validChainflipData);
        } else {
            chainflipFacet.swapAndStartBridgeTokensViaChainflip(
                bridgeData,
                swapData,
                validChainflipData
            );
        }
    }
}
