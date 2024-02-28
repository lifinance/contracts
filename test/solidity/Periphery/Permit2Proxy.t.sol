// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, TestBase, DSTest, ILiFi, console, ERC20 } from "../utils/TestBase.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { IPermit2 } from "lifi/Interfaces/IPermit2.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { ERC20Proxy } from "lifi/Periphery/ERC20Proxy.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { ERC20Permit, EIP712 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

//TODO: remove
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { console2 } from "forge-std/console2.sol";

contract Permit2ProxyTest is TestBase {
    address public constant PERMIT2ADDRESS =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant LIFIDIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    address public constant LIFIDIAMONDIMMUTABLE =
        0x9b11bc9FAc17c058CAB6286b0c785bE6a65492EF;

    string public constant _PERMIT_TRANSFER_TYPEHASH_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    string public constant _PERMIT_BATCH_WITNESS_TRANSFER_TYPEHASH_STUB =
        "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,";

    string public constant _TOKEN_PERMISSIONS_TYPESTRING =
        "TokenPermissions(address token,uint256 amount)";

    string constant WITNESS_TYPE =
        "Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)";

    string constant WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)";

    bytes32 constant FULL_WITNESS_TYPEHASH =
        keccak256(
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)"
        );

    bytes32 constant FULL_WITNESS_BATCH_TYPEHASH =
        keccak256(
            "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)"
        );

    bytes32 public constant _TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");

    Permit2Proxy public p2Proxy;
    ERC20Proxy public erc20Proxy;
    bytes32 public PERMIT2_DOMAIN_SEPARATOR;
    uint256 private _privKeyUserWallet;
    uint256 private _privKeyInvalidSignerWallet;
    address public addressUserWallet;

    // USDT contract
    address public ADDRESS_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    ERC20 public usdt;

    error UnAuthorized();
    error InvalidAmount(uint256 amount);
    error InvalidSigner();
    error InvalidNonce();

    event WhitelistUpdated(address[] addresses, bool[] values);

    struct Witness {
        address tokenReceiver;
        address diamondAddress;
        bytes diamondCalldata;
    }

    struct PermitWitnessCalldata {
        IPermit2.PermitTransferFrom permit;
        uint256 amount;
        bytes witnessData;
        address senderAddress;
        bytes signature;
    }
    struct PermitWitnessMultipleCalldata {
        IPermit2.PermitBatchTransferFrom permit;
        uint256[] amounts;
        bytes witnessData;
        address senderAddress;
        bytes signature;
    }

    struct TestDataEIP2612 {
        address tokenAddress;
        address userWallet;
        uint256 nonce;
        uint256 deadline;
        bytes diamondCalldata;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function setUp() public {
        customBlockNumberForForking = 18931144;
        initTestBase();

        // deploy an ERC20 Proxy
        erc20Proxy = new ERC20Proxy(address(this));

        // store privKey and address of test user
        _privKeyUserWallet = 0x12341234;
        _privKeyInvalidSignerWallet = 0x12341235;
        addressUserWallet = vm.addr(_privKeyUserWallet);

        usdt = ERC20(ADDRESS_USDT);

        // get domain separator from Permit2 contract
        PERMIT2_DOMAIN_SEPARATOR = IPermit2(PERMIT2ADDRESS).DOMAIN_SEPARATOR();

        // deploy Permit2Proxy
        p2Proxy = new Permit2Proxy(PERMIT2ADDRESS, address(this));

        // configure Permit2Proxy (add diamonds to whitelist)
        address[] memory addresses = new address[](2);
        addresses[0] = LIFIDIAMOND; // LiFiDiamond
        addresses[1] = LIFIDIAMONDIMMUTABLE; // LiFiDiamondImmutable
        bool[] memory values = new bool[](2);
        values[0] = true;
        values[1] = true;
        p2Proxy.updateWhitelist(addresses, values);

        // add labels
        vm.label(address(p2Proxy), "Permit2Proxy");
        vm.label(PERMIT2ADDRESS, "Permit2");
        vm.label(ADDRESS_USDT, "USDT");
        vm.label(addressUserWallet, "UserWallet");

        // deal USDC to user wallet
        deal(ADDRESS_USDC, addressUserWallet, defaultUSDCAmount);

        // max approve USDC to Permit2 contract
        vm.startPrank(addressUserWallet);
        usdc.approve(PERMIT2ADDRESS, type(uint256).max);
        vm.stopPrank();
    }

    /// Test Cases ///

    // EIP2612 (native permit) related test cases //

    function testCanExecuteCalldataUsingEIP2612SignatureUSDC() public {
        vm.startPrank(addressUserWallet);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612 memory testdata = _getTestDataEIP2612(
            ADDRESS_USDC,
            domainSeparator,
            block.timestamp + 1000
        );

        // expect LifiTransferStarted event to be emitted by our diamond contract
        vm.expectEmit(true, true, true, true, LIFIDIAMOND);
        emit LiFiTransferStarted(bridgeData);

        // call Permit2Proxy with signature
        p2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            addressUserWallet,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            LIFIDIAMOND,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testCanExecuteCalldataUsingEIP2612SignatureUNI() public {
        address ADDRESS_UNI = 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984;

        vm.startPrank(addressUserWallet);

        // make sure user has UNI balance
        deal(ADDRESS_UNI, addressUserWallet, defaultUSDCAmount);

        // get token-specific domainSeparator
        bytes32 domainSeparator = _getUNIDomainSeparator(
            ADDRESS_UNI,
            block.chainid
        );

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612 memory testdata = _getTestDataEIP2612(
            ADDRESS_UNI,
            domainSeparator,
            block.timestamp + 1000
        );

        // create adjusted calldata (with correct sendingAssetId)
        bridgeData.sendingAssetId = ADDRESS_UNI;
        testdata.diamondCalldata = abi.encodeWithSelector(
            PolygonBridgeFacet.startBridgeTokensViaPolygonBridge.selector,
            bridgeData
        );

        // expect LifiTransferStarted event to be emitted by our diamond contract
        vm.expectEmit(true, true, true, true, LIFIDIAMOND);
        emit LiFiTransferStarted(bridgeData);

        // call Permit2Proxy with signature
        p2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_UNI,
            addressUserWallet,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            LIFIDIAMOND,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevertcannotUseEIP2612SignatureTwice() public {
        vm.startPrank(addressUserWallet);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612 memory testdata = _getTestDataEIP2612(
            ADDRESS_USDC,
            domainSeparator,
            block.timestamp + 1000
        );

        // call Permit2Proxy with signature
        p2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            addressUserWallet,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            LIFIDIAMOND,
            testdata.diamondCalldata
        );

        // expect call to revert if same signature is used twice
        vm.expectRevert("EIP2612: invalid signature");
        p2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            addressUserWallet,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            LIFIDIAMOND,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevertCannotUseExpiredEIP2612Signature() public {
        vm.startPrank(addressUserWallet);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612 memory testdata = _getTestDataEIP2612(
            ADDRESS_USDC,
            domainSeparator,
            block.timestamp - 1 //  deadline in the past
        );

        // expect call to revert since signature deadline is in the past
        vm.expectRevert("FiatTokenV2: permit is expired");

        // call Permit2Proxy with signature
        p2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            addressUserWallet,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            LIFIDIAMOND,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevertCannotUseInvalidEIP2612Signature() public {
        vm.startPrank(addressUserWallet);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612 memory testdata = _getTestDataEIP2612(
            ADDRESS_USDC,
            domainSeparator,
            block.timestamp
        );

        // expect call to revert since signature deadline is in the past
        vm.expectRevert("ECRecover: invalid signature 'v' value");

        // call Permit2Proxy with signature
        p2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            addressUserWallet,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v + 1, // invalid v value
            testdata.r,
            testdata.s,
            LIFIDIAMOND,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    // Permit 2 related test cases //
    function testRevertCannotUseSignatureMoreThanOnce() public {
        // prepare calldata, sign it,
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // call Permit2Proxy and use the signature
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );

        // deal tokens to user to ensure enough tokens would be available
        deal(ADDRESS_USDC, addressUserWallet, defaultUSDCAmount);

        // expect error to be thrown
        vm.expectRevert(InvalidNonce.selector);

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevertDoesNotAllowToTransferTokensToDifferentAddress()
        public
    {
        // prepare calldata & sign it
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // get calldata (same as the one that was signed)
        bytes memory diamondCalldata = _getCalldataForBridging();

        // prepare witness with different diamondAddress
        Witness memory witnessData = Witness(
            address(this),
            LIFIDIAMOND,
            diamondCalldata
        );

        callData.witnessData = abi.encode(witnessData);

        // expect error to be thrown
        vm.expectRevert(InvalidSigner.selector);

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevertDoesNotAllowToExecuteCalldataOnDifferentDiamondAddress()
        public
    {
        // prepare calldata & sign it
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // get calldata (same as the one that was signed)
        bytes memory diamondCalldata = _getCalldataForBridging();

        // prepare witness with different diamondAddress
        Witness memory witnessData = Witness(
            address(p2Proxy),
            LIFIDIAMONDIMMUTABLE,
            diamondCalldata
        );

        callData.witnessData = abi.encode(witnessData);

        // expect error to be thrown
        vm.expectRevert(InvalidSigner.selector);

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevertDoesNotAllowToExecuteDifferentCalldata() public {
        // prepare calldata & sign it
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // create different calldata
        bytes memory invalidCalldata = "";

        // prepare witness
        Witness memory witnessData = Witness(
            address(p2Proxy),
            LIFIDIAMOND,
            invalidCalldata
        );

        callData.witnessData = abi.encode(witnessData);

        // expect error to be thrown
        vm.expectRevert(InvalidSigner.selector);

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevertWillNotAcceptSignatureFromOtherWallet() public {
        // prepare calldata & sign it
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // replace signature with signature from another wallet (same data)
        callData.signature = _getPermitWitnessTransferSignatureSingle(
            callData.permit,
            _privKeyInvalidSignerWallet,
            FULL_WITNESS_TYPEHASH,
            keccak256(callData.witnessData),
            PERMIT2_DOMAIN_SEPARATOR
        );

        // expect error to be thrown
        vm.expectRevert(InvalidSigner.selector);

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevertCannotTransferMoreThanAllowed() public {
        // prepare calldata & sign it
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // expect error to be thrown
        vm.expectRevert(
            abi.encodePacked(InvalidAmount.selector, callData.amount)
        );

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount + 1,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testCanExecuteCalldataOnDiamondSingleToken() public {
        // prepare calldata, sign it,
        PermitWitnessCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // expect event to be emitted by diamond
        vm.expectEmit(true, true, true, true, LIFIDIAMOND);
        emit LiFiTransferStarted(bridgeData);

        // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureSingle(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    // this test case showcases a multi-to-one token use case
    // scenario: bridging 100 USDC from three tokens:
    // 1) swapping 30 USDC worth of DAI to USDC @uniswap
    // 2) swapping 40 USDC worth of ETH to USDC @uniswap
    // 3) transfering 30 USDC to our diamond using a (whitelisted) ERC20Proxy
    function testCanExecuteCalldataOnDiamondMultipleTokens() public {
        // approve USDC from Permit2Proxy to diamond
        vm.startPrank(address(p2Proxy));
        usdc.approve(address(erc20Proxy), type(uint256).max);
        vm.stopPrank();

        // whitelist our diamond as caller in the ERC20Proxy
        erc20Proxy.setAuthorizedCaller(LIFIDIAMOND, true);

        // whitelist the just-deployed ERC20Proxy in our diamond
        vm.startPrank(OwnershipFacet(LIFIDIAMOND).owner());
        DexManagerFacet(LIFIDIAMOND).addDex(address(erc20Proxy));
        DexManagerFacet(LIFIDIAMOND).setFunctionApprovalBySignature(
            erc20Proxy.transferFrom.selector,
            true
        );
        vm.stopPrank();

        // send 100 DAI and 100 ETH to user
        deal(ADDRESS_DAI, addressUserWallet, 100 * 10 ** dai.decimals());
        vm.deal(addressUserWallet, 100 ether);

        // approve DAI to Permit2
        vm.startPrank(addressUserWallet);
        dai.approve(PERMIT2ADDRESS, type(uint256).max);

        // prepare calldata (including swaps) and sign it
        (
            PermitWitnessMultipleCalldata memory callData,
            uint256 msgValue
        ) = _getPermitWitnessBatchCalldata();

        // // expect event to be emitted by diamond
        vm.expectEmit(true, true, true, true, LIFIDIAMOND);
        emit LiFiTransferStarted(bridgeData);

        // // call Permit2Proxy
        p2Proxy.callDiamondWithPermit2SignatureBatch{ value: msgValue }(
            callData.permit,
            callData.amounts,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevertNonOwnerCannotUpdateWhitelist() public {
        vm.startPrank(USER_SENDER);
        address[] memory addresses = new address[](2);
        addresses[0] = LIFIDIAMOND; // LiFiDiamond
        addresses[1] = LIFIDIAMONDIMMUTABLE; // LiFiDiamondImmutable
        bool[] memory values = new bool[](2);
        values[0] = true;
        values[1] = true;

        vm.expectRevert(UnAuthorized.selector);
        p2Proxy.updateWhitelist(addresses, values);
    }

    function test_tstTMP() public {
        console2.log("yeah");
        bytes
            // memory expWitnessData = hex"0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a445b84904612bf2d17f56fbd6759b65f7ba51ea0000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001e48bf6ef990000000000000000000000000000000000000000000000000000000000000020b0e325feb1a868db95b7a6d5c125b4ce493118bb27dbe5a6e8d5137ad70a3b470000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000668797068656e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d61706900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
            memory expWitnessData = hex"0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a445b84904612bf2d17f56fbd6759b65f7ba51ea0000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001e48bf6ef99000000000000000000000000000000000000000000000000000000000000002004a6a8899493cc26b4db400c8d9d1bef481c4e199bef656453d9ab70b3d7538f0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000668797068656e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d61706900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        bytes
            memory expDiamondCalldata = hex"8bf6ef99000000000000000000000000000000000000000000000000000000000000002004a6a8899493cc26b4db400c8d9d1bef481c4e199bef656453d9ab70b3d7538f0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000668797068656e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d617069000000000000000000000000000000000000000000000000";
        // prepare witness
        Witness memory witnessData = Witness(
            0xA445b84904612Bf2d17F56FBD6759B65F7ba51eA,
            0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE,
            // hex"8bf6ef990000000000000000000000000000000000000000000000000000000000000020b0e325feb1a868db95b7a6d5c125b4ce493118bb27dbe5a6e8d5137ad70a3b470000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000668797068656e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d617069000000000000000000000000000000000000000000000000"
            expDiamondCalldata

        );

        bytes memory data = abi.encode(witnessData);
        bytes32 witness = keccak256(data);

        // console2.log("witnessData:");
        // console2.logBytes(data);
        // console2.log("witness:");
        // console2.logBytes32(witness);

        // decode witnessData to obtain calldata and diamondAddress
        Witness memory decodedWitness = abi.decode(data, (Witness));

        console2.log(
            "decodedWitness.tokenReceiver: ",
            decodedWitness.tokenReceiver
        );
        console2.log(
            "decodedWitness.diamondAddress: ",
            decodedWitness.diamondAddress
        );
        console.log("decodedWitness.diamondCalldata: ");
        console2.logBytes(decodedWitness.diamondCalldata);

        console.log("");
        console.log("");
        console.log("expWitnessData: ");
        console2.logBytes(expWitnessData);
        console.log("");
        console.log("actWitnessData: ");
        console2.logBytes(data);
        console.log("expWitnessData === actWitnessData: ", keccak256(expWitnessData) == keccak256(data));
        console.log("expectedDiamondCalldata === decodedDiamondCalldata: ", keccak256(expDiamondCalldata) == keccak256(decodedWitness.diamondCalldata));
    }

    // this test passes >> witnessData seems to be OK
    function test_decodesWitnessDataAsExpected() public {
        // the witnessData that should be decoded
        bytes
            memory encodedWitnessData = hex"0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a445b84904612bf2d17f56fbd6759b65f7ba51ea0000000000000000000000001231deb6f5749ef6ce6943a275a1d3e7486f4eae000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000001e48bf6ef99000000000000000000000000000000000000000000000000000000000000002004a6a8899493cc26b4db400c8d9d1bef481c4e199bef656453d9ab70b3d7538f0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000668797068656e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d61706900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

        // the expected decoded values
        address expTokenReceiver = 0xA445b84904612Bf2d17F56FBD6759B65F7ba51eA;
        address expDiamondAddress = 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
        bytes
            memory expDiamondCalldata = hex"8bf6ef99000000000000000000000000000000000000000000000000000000000000002004a6a8899493cc26b4db400c8d9d1bef481c4e199bef656453d9ab70b3d7538f0000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008ac76a51cc950d9822d68b83fe1ad97b32cd580d00000000000000000000000029dacdf7ccadf4ee67c923b4c22255a4b2494ed70000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008900000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000668797068656e000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000086c6966692d617069000000000000000000000000000000000000000000000000";


        // decode witnessData
        Witness memory decodedWitness = abi.decode(encodedWitnessData, (Witness));

        assertEq(decodedWitness.tokenReceiver, expTokenReceiver);
        assertEq(decodedWitness.diamondAddress, expDiamondAddress);
        assertEq(keccak256(expDiamondCalldata), keccak256(decodedWitness.diamondCalldata));
    }

    function testRevertOwnerCanUpdateWhitelist() public {
        // make sure whitelist is set correctly
        assertEq(p2Proxy.diamondWhitelist(LIFIDIAMOND), true);
        assertEq(p2Proxy.diamondWhitelist(LIFIDIAMONDIMMUTABLE), true);

        // prepare parameters
        address[] memory addresses = new address[](2);
        addresses[0] = LIFIDIAMOND; // LiFiDiamond
        addresses[1] = LIFIDIAMONDIMMUTABLE; // LiFiDiamondImmutable
        bool[] memory values = new bool[](2);
        values[0] = false;
        values[1] = false;

        // expect event to be emitted by Permit2Proxy with correct parameters
        vm.expectEmit(true, true, true, true, address(p2Proxy));
        emit WhitelistUpdated(addresses, values);

        // update whitelist
        p2Proxy.updateWhitelist(addresses, values);

        // make sure whitelist was updated
        assertEq(p2Proxy.diamondWhitelist(LIFIDIAMOND), false);
        assertEq(p2Proxy.diamondWhitelist(LIFIDIAMONDIMMUTABLE), false);
    }

    /// Helper Functions ///

    function _getCalldataForBridging()
        private
        view
        returns (bytes memory diamondCalldata)
    {
        bytes4 selector = PolygonBridgeFacet
            .startBridgeTokensViaPolygonBridge
            .selector;

        diamondCalldata = abi.encodeWithSelector(selector, bridgeData);
    }

    function _getCalldataForBridgingBatch()
        private
        returns (bytes memory diamondCalldata, uint256[] memory amounts)
    {
        bytes4 selector = PolygonBridgeFacet
            .swapAndStartBridgeTokensViaPolygonBridge
            .selector;

        // create amounts array
        uint256 erc20toUsdcOut = 30 * 10 ** usdc.decimals();
        uint256 wethtoUsdcOut = 40 * 10 ** usdc.decimals();

        // create path arrays
        address[] memory daiPath = _getAddressArray(ADDRESS_DAI, ADDRESS_USDC);
        address[] memory wethPath = _getAddressArray(
            ADDRESS_WETH,
            ADDRESS_USDC
        );

        // get uniswap input amounts for each swap
        amounts = new uint256[](2);
        amounts[0] = _getUniswapAmountIn(daiPath, erc20toUsdcOut);
        amounts[1] = _getUniswapAmountIn(wethPath, wethtoUsdcOut);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](3);
        // create swap calldata for DAI > USDC
        swapData[0] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: ADDRESS_DAI,
            receivingAssetId: ADDRESS_USDC,
            fromAmount: amounts[0],
            callData: abi.encodeWithSelector(
                uniswap.swapTokensForExactTokens.selector,
                erc20toUsdcOut,
                amounts[0],
                daiPath,
                LIFIDIAMOND,
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // create swap calldata for ETH/WETH > USDC
        swapData[1] = LibSwap.SwapData({
            callTo: address(uniswap),
            approveTo: address(uniswap),
            sendingAssetId: address(0),
            receivingAssetId: ADDRESS_USDC,
            fromAmount: amounts[1],
            callData: abi.encodeWithSelector(
                uniswap.swapETHForExactTokens.selector,
                wethtoUsdcOut,
                wethPath,
                LIFIDIAMOND,
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });

        // create swap calldata for transferring USDC from Permit2 to Diamond using (whitelisted) ERC20Proxy
        swapData[2] = LibSwap.SwapData({
            callTo: address(erc20Proxy),
            approveTo: address(erc20Proxy),
            sendingAssetId: ADDRESS_USDC,
            receivingAssetId: ADDRESS_USDC,
            fromAmount: erc20toUsdcOut,
            callData: abi.encodeWithSelector(
                erc20Proxy.transferFrom.selector,
                ADDRESS_USDC,
                address(p2Proxy),
                LIFIDIAMOND,
                erc20toUsdcOut
            ),
            requiresDeposit: false
        });

        // update bridgeData
        bridgeData.hasSourceSwaps = true;

        // create encoded calldata from bridgeData & swapData
        diamondCalldata = abi.encodeWithSelector(
            selector,
            bridgeData,
            swapData
        );
    }

    function _defaultERC20PermitWitnessTransfer(
        address token0,
        uint256 amount,
        uint256 nonce
    ) internal view returns (IPermit2.PermitTransferFrom memory) {
        return
            IPermit2.PermitTransferFrom({
                permitted: IPermit2.TokenPermissions({
                    token: token0,
                    amount: amount
                }),
                nonce: nonce,
                deadline: block.timestamp + 100
            });
    }

    function _multipleERC20PermitWitnessTransfer(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256 nonce
    ) internal view returns (IPermit2.PermitBatchTransferFrom memory permit) {
        IPermit2.TokenPermissions[]
            memory permissions = new IPermit2.TokenPermissions[](
                tokens.length
            );
        for (uint i; i < tokens.length; i++) {
            permissions[i] = IPermit2.TokenPermissions({
                token: tokens[i],
                amount: amounts[i]
            });
        }

        permit.permitted = permissions;
        permit.nonce = nonce;
        permit.deadline = block.timestamp + 100;
    }

    function _getPermitWitnessTransferSignatureSingle(
        IPermit2.PermitTransferFrom memory permit,
        uint256 privateKey,
        bytes32 typeHash,
        bytes32 witness,
        bytes32 domainSeparator
    ) internal view returns (bytes memory sig) {
        // create msgHash and sign it with private key
        return
            _createAndSignMsgHash(
                domainSeparator,
                typeHash,
                keccak256(
                    abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted)
                ),
                permit.nonce,
                permit.deadline,
                witness,
                privateKey
            );
    }

    function _getPermitWitnessTransferSignatureBatch(
        IPermit2.PermitBatchTransferFrom memory permit,
        uint256 privateKey,
        bytes32 typeHash,
        bytes32 witness,
        bytes32 domainSeparator
    ) internal view returns (bytes memory sig) {
        // create tokenPermissions for all tokens in this batch
        bytes32[] memory tokenPermissions = new bytes32[](
            permit.permitted.length
        );
        for (uint256 i = 0; i < permit.permitted.length; ++i) {
            tokenPermissions[i] = keccak256(
                abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted[i])
            );
        }

        // create msgHash and sign it with private key
        return
            _createAndSignMsgHash(
                domainSeparator,
                typeHash,
                keccak256(abi.encodePacked(tokenPermissions)),
                permit.nonce,
                permit.deadline,
                witness,
                privateKey
            );
    }

    function _createAndSignMsgHash(
        bytes32 domainSeparator,
        bytes32 typeHash,
        bytes32 tokenPermissions,
        uint256 nonce,
        uint256 deadline,
        bytes32 witness,
        uint256 privateKey
    ) internal view returns (bytes memory signature) {
        // get a hash from well-structured data that can be signed by user
        bytes32 msgHash = _getMsgHash(
            domainSeparator,
            typeHash,
            tokenPermissions,
            nonce,
            deadline,
            witness
        );

        // sign data and return signature
        (, , , signature) = _signHash(privateKey, msgHash);
    }

    function _signHash(
        uint256 privateKey,
        bytes32 msgHash
    )
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s, bytes memory signature)
    {
        // create signature in ECDSA format
        (v, r, s) = vm.sign(privateKey, msgHash);

        // create bytes representation of signature to match target format
        signature = bytes.concat(r, s, bytes1(v));
    }

    function _getMsgHash(
        bytes32 domainSeparator,
        bytes32 typeHash,
        bytes32 tokenPermissions,
        uint256 nonce,
        uint256 deadline,
        bytes32 witness
    ) internal view returns (bytes32 msgHash) {
        msgHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(
                    abi.encode(
                        typeHash,
                        tokenPermissions,
                        address(p2Proxy),
                        nonce,
                        deadline,
                        witness
                    )
                )
            )
        );
    }

    function _getPermitWitnessSingleCalldata()
        internal
        view
        returns (PermitWitnessCalldata memory permitCalldata)
    {
        // prepare calldata for bridging
        bytes memory diamondCalldata = _getCalldataForBridging();
        uint256 nonce = 0;

        // prepare witness
        Witness memory witnessData = Witness(
            address(p2Proxy),
            LIFIDIAMOND,
            diamondCalldata
        );

        permitCalldata.witnessData = abi.encode(witnessData);
        bytes32 witness = keccak256(permitCalldata.witnessData);

        // prepare permit object
        permitCalldata.permit = _defaultERC20PermitWitnessTransfer(
            ADDRESS_USDC,
            defaultUSDCAmount,
            nonce
        );

        // sign permit and witness with privateKey
        permitCalldata.signature = _getPermitWitnessTransferSignatureSingle(
            permitCalldata.permit,
            _privKeyUserWallet,
            FULL_WITNESS_TYPEHASH,
            witness,
            PERMIT2_DOMAIN_SEPARATOR
        );

        permitCalldata.amount = defaultUSDCAmount;
        permitCalldata.senderAddress = addressUserWallet;
    }

    function _getPermitWitnessBatchCalldata()
        internal
        returns (
            PermitWitnessMultipleCalldata memory permitCalldata,
            uint256 msgValue
        )
    {
        // prepare calldata for bridging
        (
            bytes memory diamondCalldata,
            uint256[] memory amounts
        ) = _getCalldataForBridgingBatch();
        uint256 nonce = 0;

        // prepare witness
        Witness memory witnessData = Witness(
            address(p2Proxy),
            LIFIDIAMOND,
            diamondCalldata
        );
        permitCalldata.witnessData = abi.encode(witnessData);
        bytes32 witness = keccak256(permitCalldata.witnessData);

        // get list of tokens that need to be transferred to Permit2Proxy
        address[] memory tokens = _getAddressArray(ADDRESS_DAI, ADDRESS_USDC);

        // get amounts that need to be transferred to Permit2Proxy
        uint256[] memory transferAmounts = new uint256[](2);
        transferAmounts[0] = amounts[0];
        transferAmounts[1] = 60 * 10 ** usdc.decimals();

        // prepare permit object
        permitCalldata.permit = _multipleERC20PermitWitnessTransfer(
            tokens,
            transferAmounts,
            nonce
        );

        // sign permit and witness with privateKey
        permitCalldata.signature = _getPermitWitnessTransferSignatureBatch(
            permitCalldata.permit,
            _privKeyUserWallet,
            FULL_WITNESS_BATCH_TYPEHASH,
            witness,
            PERMIT2_DOMAIN_SEPARATOR
        );

        // add amount and sender info
        permitCalldata.amounts = transferAmounts;
        permitCalldata.senderAddress = addressUserWallet;

        // update msgValue (amountIn for ETH swap)
        msgValue = amounts[1];
    }

    function _getUniswapAmountIn(
        address[] memory path,
        uint256 amountOut
    ) internal view returns (uint256 amountIn) {
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        amountIn = amounts[0];
    }

    function _getAddressArray(
        address firstAddress,
        address secondAddress
    ) internal pure returns (address[] memory addresses) {
        addresses = new address[](2);
        addresses[0] = firstAddress;
        addresses[1] = secondAddress;
    }

    function _generateEIP2612MsgHash(
        address owner,
        address spender,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes32 domainSeparator
    ) internal pure returns (bytes32 digest) {
        digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                // Domain separator
                domainSeparator,
                // Permit struct
                keccak256(
                    abi.encode(
                        keccak256(
                            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                        ),
                        owner,
                        spender,
                        amount,
                        nonce,
                        deadline
                    )
                )
            )
        );
    }

    function _getTestDataEIP2612(
        address tokenAddress,
        bytes32 domainSeparator,
        uint256 deadline
    ) internal view returns (TestDataEIP2612 memory testdata) {
        testdata.tokenAddress = tokenAddress;
        testdata.userWallet = addressUserWallet;
        testdata.nonce = ERC20Permit(tokenAddress).nonces(testdata.userWallet);
        testdata.deadline = deadline;

        // generate approval data to be signed by user
        bytes32 digest = _generateEIP2612MsgHash(
            testdata.userWallet,
            address(p2Proxy),
            defaultUSDCAmount,
            testdata.nonce,
            testdata.deadline,
            domainSeparator
        );

        // sign digest and return signature
        (testdata.v, testdata.r, testdata.s, ) = _signHash(
            _privKeyUserWallet,
            digest
        );

        // get calldata for bridging (simple USDC bridging via PolygonBridge)
        testdata.diamondCalldata = _getCalldataForBridging();
    }

    function _getUNIDomainSeparator(
        address tokenAddress,
        uint256 chainId
    ) internal view returns (bytes32 domainSeparator) {
        bytes32 UNI_DOMAIN_TYPEHASH = keccak256(
            "EIP712Domain(string name,uint256 chainId,address verifyingContract)"
        );

        // get token name from contract
        string memory name = ERC20(tokenAddress).name();

        // generate domainSeparator
        domainSeparator = keccak256(
            abi.encode(
                UNI_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                chainId,
                tokenAddress
            )
        );
    }
}
