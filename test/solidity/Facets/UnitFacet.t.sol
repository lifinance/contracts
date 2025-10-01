// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { UnitFacet } from "lifi/Facets/UnitFacet.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InvalidSendingToken, InvalidAmount, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";
import { console2 } from "forge-std/console2.sol";

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

    // backend signer private key and address
    uint256 internal backendSignerPrivateKey =
        0x1234567890123456789012345678901234567890123456789012345678901234;
    address internal backendSignerAddress = vm.addr(backendSignerPrivateKey);
    address internal randomDepositAddress = 0xCE50D8e79e047534627B3Bc38DE747426Ec63927;

    // unit node public key
    bytes internal unitNodePublicKey =
        hex"04dc6f89f921dc816aa69b687be1fcc3cc1d48912629abc2c9964e807422e1047e0435cb5ba0fa53cb9a57a9c610b4e872a0a2caedda78c4f85ebafcca93524061";
    // h1 node public key
    bytes internal h1NodePublicKey =
        hex"048633ea6ab7e40cdacf37d1340057e84bb9810de0687af78d031e9b07b65ad4ab379180ab55075f5c2ebb96dab30d2c2fab49d5635845327b6a3c27d20ba4755b";
    // field node public key
    bytes internal fieldNodePublicKey =
        hex"04ae2ab20787f816ea5d13f36c4c4f7e196e29e867086f3ce818abb73077a237f841b33ada5be71b83f4af29f333dedc5411ca4016bd52ab657db2896ef374ce99";

    struct UnitPayload {
        bytes32 transactionId;
        uint256 minAmount;
        address depositAddress;
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sendingAssetId;
        uint256 deadline;
    }

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
        // whitelist uniswap dex with function selectors
        unitFacet.addDex(address(uniswap));
        unitFacet.addDex(address(unitFacet));
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        unitFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
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

        bridgeData.receiver = randomDepositAddress;

        validUnitData = _generateValidUnitData(randomDepositAddress, bridgeData, block.chainid);
    }

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

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public virtual override {
        // facet does not support bridging ERC20 tokens
    }

    function testBase_CanSwapAndBridgeTokens() public virtual override {
        // facet does not support bridging ERC20 tokens
    }

    function testRevert_CanNotBridgeERC20Tokens() public virtual {
        // facet does not support bridging ERC20 tokens
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        usdc.approve(address(unitFacet), bridgeData.minAmount);

        vm.expectRevert(abi.encodeWithSelector(InvalidSendingToken.selector));
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
                bridgeData,
                validUnitData
            );

        vm.stopPrank();
    }

    function testRevert_CanNotSwapAndBridgeERC20Tokens() public virtual {
        // facet does not support bridging ERC20 tokens
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        usdc.approve(address(unitFacet), bridgeData.minAmount);

        vm.expectRevert(abi.encodeWithSelector(InvalidSendingToken.selector));
        unitFacet.swapAndStartBridgeTokensViaUnit{ value: bridgeData.minAmount }(
                bridgeData,
                swapData,
                validUnitData
            );

        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens()
        public
        virtual
        override
        assertBalanceChange(address(0), USER_SENDER, -int256(0.05 ether))
        assertBalanceChange(address(0), USER_RECEIVER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_SENDER, 0)
        assertBalanceChange(ADDRESS_DAI, USER_RECEIVER, 0)
    {
        vm.startPrank(USER_SENDER);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(unitFacet));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset create swapData (300 DAI to native) - it has to be at least 0.05 ETH
        uint256 daiAmount = 300 * 10 ** dai.decimals();

        // Swap DAI -> ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsOut(daiAmount, path);
        uint256 amountOut = amounts[1];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: daiAmount,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    daiAmount,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        dai.approve(_facetTestContractAddress, daiAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            daiAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        UnitFacet.UnitData memory unitData = _generateValidUnitData(randomDepositAddress, bridgeData, 1);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        // the startBridgeTokensViaUnit can only be used for native tokens, therefore this test case is not applicable
    }

    function test_CanSwapAndBridgeNativeTokens_fuzzed(uint256 amount) public {
        vm.assume(amount > 215 && amount < 100_000); // 215 a little bit above the minimum amount for a swap (0.05 ETH)
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;

        // reset create swapData (300 DAI to native) - it has to be at least 0.05 ETH
        uint256 daiAmount = amount * 10 ** dai.decimals();

        // Swap DAI -> ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsOut(daiAmount, path);
        uint256 amountOut = amounts[1];
        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: daiAmount,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForETH.selector,
                    daiAmount,
                    amountOut,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // approval
        dai.approve(_facetTestContractAddress, daiAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            address(0),
            daiAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testRevert_InvalidMinimumAmount() public {
        vm.startPrank(USER_SENDER);

        vm.chainId(1); // Set chain ID to plasma
        // Set amount below minimum for plasma (0.05 ETH)
        bridgeData.minAmount = 0.04 ether; // Below 0.05 ETH minimum
        // Regenerate signature for plasma chain
        UnitFacet.UnitData memory unitData = _generateValidUnitData(randomDepositAddress, bridgeData, 1);
        
        vm.expectRevert(abi.encodeWithSelector(InvalidAmount.selector));
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            unitData
        );

        vm.chainId(9745); // Set chain ID to plasma
        // Set amount below minimum for plasma (15 XPL)
        bridgeData.minAmount = 10 ether; // Below 15 XPL minimum
        // Regenerate signature for plasma chain
        unitData = _generateValidUnitData(randomDepositAddress, bridgeData, 9745);
        
        vm.expectRevert(abi.encodeWithSelector(InvalidAmount.selector));
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            unitData
        );

        vm.stopPrank();
    }

    function testRevert_InvalidReceiver() public {
        vm.startPrank(USER_SENDER);

        // Create unit data with different deposit address than receiver
        address differentDepositAddress = address(0x1234567890123456789012345678901234567890);
        bridgeData.receiver = address(0x9876543210987654321098765432109876543210); // Different from deposit address

        UnitFacet.UnitData memory invalidUnitData = UnitFacet.UnitData({
            depositAddress: differentDepositAddress,
            signature: validUnitData.signature, // Using existing signature (will fail receiver check first)
            deadline: validUnitData.deadline
        });

        vm.expectRevert(abi.encodeWithSelector(InvalidReceiver.selector));
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            invalidUnitData
        );

        vm.stopPrank();
    }

    function testRevert_InvalidSignature() public {
        vm.startPrank(USER_SENDER);

        // Create a signature with a different private key (wrong signer)
        uint256 wrongPrivateKey = 0x9876543210987654321098765432109876543210987654321098765432109876;
        
        // Generate the same payload but sign it with wrong private key
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("LI.FI Unit Facet")),
                keccak256(bytes("1")),
                block.chainid,
                address(unitFacet)
            )
        );

        UnitPayload memory payload = UnitPayload({
            transactionId: bridgeData.transactionId,
            minAmount: bridgeData.minAmount,
            depositAddress: validUnitData.depositAddress,
            sourceChainId: block.chainid,
            destinationChainId: bridgeData.destinationChainId,
            sendingAssetId: bridgeData.sendingAssetId,
            deadline: validUnitData.deadline
        });

        bytes32 unitPayloadTypehash = 0x0f323247869e99767f8ae64818f8e3049ae421f0e0fc249a40a1179278dc1648;
        bytes32 structHash = keccak256(
            abi.encode(
                unitPayloadTypehash,
                payload.transactionId,
                payload.minAmount,
                payload.depositAddress,
                payload.sourceChainId,
                payload.destinationChainId,
                payload.sendingAssetId,
                payload.deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        // Sign with wrong private key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPrivateKey, digest);
        bytes memory wrongSignature = abi.encodePacked(r, s, v);

        UnitFacet.UnitData memory invalidUnitData = UnitFacet.UnitData({
            depositAddress: validUnitData.depositAddress,
            signature: wrongSignature, // Valid signature format but from wrong signer
            deadline: validUnitData.deadline
        });

        vm.expectRevert(abi.encodeWithSelector(UnitFacet.InvalidSignature.selector));
        unitFacet.startBridgeTokensViaUnit{ value: bridgeData.minAmount }(
            bridgeData,
            invalidUnitData
        );

        vm.stopPrank();
    }

    /// @dev Helper function to generate valid unit data for a given chain and bridge data.
    function _generateValidUnitData(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId
    ) internal view returns (UnitFacet.UnitData memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("LI.FI Unit Facet")),
                keccak256(bytes("1")),
                _chainId,
                address(unitFacet)
            )
        );

        uint256 deadline = block.timestamp + 0.1 hours;
        UnitPayload memory payload = UnitPayload({
            transactionId: _currentBridgeData.transactionId,
            minAmount: _currentBridgeData.minAmount,
            depositAddress: _depositAddress,
            sourceChainId: _chainId,
            destinationChainId: _currentBridgeData.destinationChainId,
            sendingAssetId: _currentBridgeData.sendingAssetId,
            deadline: deadline
        });

        console2.log("payload data in the test");
        console2.logBytes32(payload.transactionId);
        console2.log(payload.minAmount);
        console2.log(payload.depositAddress);
        console2.log(payload.sourceChainId);
        console2.log(payload.destinationChainId);
        console2.log(payload.sendingAssetId);
        console2.log(deadline);

        // keccak256("UnitPayload(bytes32 transactionId,uint256 minAmount,address depositAddress,uint256 sourceChainId,uint256 destinationChainId,address sendingAssetId,uint256 deadline)");
        bytes32 unitPayloadTypehash = 0x0f323247869e99767f8ae64818f8e3049ae421f0e0fc249a40a1179278dc1648;

        bytes32 structHash = keccak256(
            abi.encode(
                unitPayloadTypehash,
                payload.transactionId,
                payload.minAmount,
                payload.depositAddress,
                payload.sourceChainId,
                payload.destinationChainId,
                payload.sendingAssetId,
                payload.deadline
            )
        );

        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            backendSignerPrivateKey,
            digest
        );
        bytes memory signature = abi.encodePacked(r, s, v);

        return
            UnitFacet.UnitData({
                depositAddress: _depositAddress,
                deadline: deadline,
                signature: signature
            });
    }
}
