// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { UnitFacet } from "lifi/Facets/UnitFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

// Stub UnitFacet Contract
contract TestUnitFacet is UnitFacet {
    constructor(address _backendSigner) UnitFacet(_backendSigner) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract UnitFacetTest is TestBaseFacet {
    UnitFacet.UnitData internal validUnitData;
    TestUnitFacet internal unitFacet;

    // Add private key and generate signer address from it
    uint256 internal backendSignerPrivateKey =
        0x1234567890123456789012345678901234567890123456789012345678901234;
    address internal backendSignerAddress = vm.addr(backendSignerPrivateKey);

    bytes internal unitNodePublicKey =
        hex"04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061";
    bytes internal h1NodePublicKey =
        hex"048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b";
    bytes internal fieldNodePublicKey =
        hex"04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99";

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        unitFacet = new TestUnitFacet(backendSignerAddress);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = unitFacet.startBridgeTokensViaUnit.selector;
        functionSelectors[1] = unitFacet
            .swapAndStartBridgeTokensViaUnit
            .selector;
        functionSelectors[2] = unitFacet.addDex.selector;
        functionSelectors[3] = unitFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(unitFacet), functionSelectors);
        unitFacet = TestUnitFacet(address(diamond));
        unitFacet.addDex(ADDRESS_UNISWAP);
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(unitFacet), "UnitFacet");

        // adjust bridgeData
        bridgeData.bridge = "unit";
        bridgeData.destinationChainId = 999;
        bridgeData.sendingAssetId = LibAsset.NULL_ADDRESS;
        bridgeData.minAmount = 0.05 ether; // minimum amount is 0.05 ETH (5e16 wei) mentioned in https://docs.hyperunit.xyz/developers/api/generate-address

        // deposit address generated with GET request to https://api.hyperunit.xyz/gen/ethereum/hyperliquid/eth/0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62

        // --- Generate Valid EIP-712 Signature Dynamically ---

        // 1. Re-calculate DOMAIN_SEPARATOR
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("LI.FI Unit Facet")),
                keccak256(bytes("1")),
                block.chainid,
                address(unitFacet) // The verifying contract is the diamond
            )
        );

        // 2. Define the payload that will be signed
        address depositAddress = 0xCE50D8e79e047534627B3Bc38DE747426Ec63927;
        UnitFacet.UnitPayload memory payload = UnitFacet.UnitPayload({
            depositAddress: depositAddress,
            sourceChainId: block.chainid,
            destinationChainId: bridgeData.destinationChainId,
            receiver: bridgeData.receiver,
            sendingAssetId: bridgeData.sendingAssetId
        });

        // 3. Calculate the hash of the struct
        bytes32 unitPayloadTypehash = 0x7143926c49a647038e3a15f0b795e1e55913e2f574a4ea414b21b7114611453c;
        bytes32 structHash = keccak256(
            abi.encode(
                unitPayloadTypehash,
                payload.depositAddress,
                payload.sourceChainId,
                payload.destinationChainId,
                payload.receiver,
                payload.sendingAssetId
            )
        );

        // 4. Calculate the final digest to sign, matching the contract's logic
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        // 5. Sign the digest with the backend private key using a cheatcode
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            backendSignerPrivateKey,
            digest
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        validUnitData = UnitFacet.UnitData({
            depositAddress: depositAddress,
            signature: signature
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
            unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
                bridgeData,
                validUnitData
            );
        } else {
            unitFacet.startBridgeTokensViaUnit(bridgeData, validUnitData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            unitFacet.swapAndStartBridgeTokensViaUnit{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validUnitData);
        } else {
            unitFacet.swapAndStartBridgeTokensViaUnit(
                bridgeData,
                swapData,
                validUnitData
            );
        }
    }

    function test_CanDepositNativeTokens() public {
        initiateBridgeTxWithFacet(true);
    }

    function testBase_CanBridgeTokens() public virtual override {
        // facet does not support bridging ERC20 tokens
    }

    function testBase_CanBridgeNativeTokens()
        public
        virtual
        override
        assertBalanceChange(
            address(0),
            USER_SENDER,
            -int256(0.05 ether)
        )
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(unitFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}
