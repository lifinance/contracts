// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { TestBase } from "../utils/TestBase.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";
import { stdError } from "forge-std/Test.sol";

abstract contract BaseMockPermitToken is ERC20, ERC20Permit {
    constructor() ERC20("Mock", "MCK") ERC20Permit("Mock") {}

    function permit(
        address,
        address,
        uint256,
        uint256,
        uint8,
        bytes32,
        bytes32
    ) public pure override {
        _permit();
    }

    function _permit() internal pure virtual;
}

contract MockPermitToken is BaseMockPermitToken {
    function _permit() internal pure override {
        revert CustomPermitError();
    }

    error CustomPermitError();
}

contract MockPermitTokenPanic is BaseMockPermitToken {
    // solhint-disable-next-line reason-string
    function _permit() internal pure override {
        assert(true == false);
    }
}

contract MockPermitTokenEmptyRevert is BaseMockPermitToken {
    function _permit() internal pure override {
        // solhint-disable-next-line gas-custom-errors,reason-string
        revert();
    }
}

contract MockPermitTokenStringRevert is BaseMockPermitToken {
    function _permit() internal pure override {
        // solhint-disable-next-line gas-custom-errors
        revert("Custom error message");
    }
}

contract MockPermitTokenRequireRevert is BaseMockPermitToken {
    function _permit() internal pure override {
        // solhint-disable-next-line gas-custom-errors
        require(true == false, "Test revert message");
    }
}

contract MockPermitTokenAdditionOverflow is BaseMockPermitToken {
    function _permit() internal pure override {
        uint256 max = type(uint256).max;
        max + 1; // runtime overflow → Panic(0x11)
    }
}

contract MockPermitTokenDivisionByZero is BaseMockPermitToken {
    function _permit() internal pure override {
        uint256 x = 0;
        uint256 y = 1 / x; // This will cause a division by zero at runtime
        x + y; // to silence unused variable warning
    }
}

contract Permit2ProxyTest is TestBase {
    using PermitHash for ISignatureTransfer.PermitTransferFrom;

    /// Constants / Immutables ///

    address internal constant PERMIT2_ADDRESS =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 internal constant PRIVATE_KEY = 0x1234567890;
    address internal constant DIAMOND_ADDRESS =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;

    /// Storage ///

    bytes32 internal permitWithWitnessTypehash;
    Permit2Proxy internal permit2Proxy;
    ISignatureTransfer internal uniPermit2;
    address internal permit2User;

    /// Types ///

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

    /// Errors ///

    error InvalidSigner();
    error InvalidNonce();
    error DiamondAddressNotWhitelisted();
    error CallToDiamondFailed(bytes);

    function setUp() public override {
        customBlockNumberForForking = 20261175;
        initTestBase();

        uniPermit2 = ISignatureTransfer(PERMIT2_ADDRESS);
        permit2Proxy = new Permit2Proxy(
            DIAMOND_ADDRESS,
            uniPermit2,
            USER_DIAMOND_OWNER
        );
        permitWithWitnessTypehash = keccak256(
            abi.encodePacked(
                PermitHash._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
                permit2Proxy.WITNESS_TYPE_STRING()
            )
        );

        permit2User = vm.addr(PRIVATE_KEY);
        vm.label(permit2User, "Permit2 User");
        deal(ADDRESS_USDC, permit2User, 10000 ether);

        // Infinite approve to Permit2
        vm.prank(permit2User);
        ERC20(ADDRESS_USDC).approve(PERMIT2_ADDRESS, type(uint256).max);
    }

    /// Tests ///

    /// EIP2612 (native permit) related test cases ///

    function test_can_execute_calldata_using_eip2612_signature_usdc()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            permit2User,
            -int256(defaultUSDCAmount)
        )
        returns (TestDataEIP2612 memory)
    {
        vm.startPrank(permit2User);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612
            memory testdata = _getTestDataEIP2612SignedBypermit2User(
                ADDRESS_USDC,
                domainSeparator,
                block.timestamp + 1000
            );

        // expect LifiTransferStarted event to be emitted by our diamond contract
        vm.expectEmit(true, true, true, true, DIAMOND_ADDRESS);
        emit LiFiTransferStarted(bridgeData);

        // call Permit2Proxy with signature
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );
        vm.stopPrank();
        return testdata;
    }

    function testRevert_when_called_with_invalid_calldata() public {
        vm.startPrank(permit2User);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612
            memory testdata = _getTestDataEIP2612SignedBypermit2User(
                ADDRESS_USDC,
                domainSeparator,
                block.timestamp + 1000
            );

        // call Permit2Proxy with signature
        vm.expectRevert(
            abi.encodeWithSignature(
                "CallToDiamondFailed(bytes)",
                hex"a9ad62f8" // Function does not exist
            )
        );
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            hex"1337c0d3" // This should revert as the method does not exist
        );
    }

    function testRevert_cannot_use_eip2612_signature_twice() public {
        TestDataEIP2612
            memory testdata = test_can_execute_calldata_using_eip2612_signature_usdc();

        vm.startPrank(permit2User);

        // // expect call to revert if same signature is used twice
        vm.expectRevert("EIP2612: invalid signature");
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevert_cannot_use_expired_eip2612_signature() public {
        vm.startPrank(permit2User);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612
            memory testdata = _getTestDataEIP2612SignedBypermit2User(
                ADDRESS_USDC,
                domainSeparator,
                block.timestamp - 1 //  deadline in the past
            );

        // expect call to revert since signature deadline is in the past
        vm.expectRevert("FiatTokenV2: permit is expired");

        // call Permit2Proxy with signature
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevert_cannot_use_invalid_eip2612_signature() public {
        vm.startPrank(permit2User);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612
            memory testdata = _getTestDataEIP2612SignedBypermit2User(
                ADDRESS_USDC,
                domainSeparator,
                block.timestamp
            );

        // expect call to revert since signature is invalid
        vm.expectRevert("ECRecover: invalid signature 'v' value");

        // call Permit2Proxy with signature
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            30, // invalid v value (valid values are 27, 28)
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevert_sign_and_call_using_different_addresses() public {
        vm.startPrank(USER_SENDER);

        // get token-specific domainSeparator
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        // // using USDC on ETH for testing (implements EIP2612)
        TestDataEIP2612
            memory testdata = _getTestDataEIP2612SignedBypermit2User(
                ADDRESS_USDC,
                domainSeparator,
                block.timestamp
            );

        // expect call to revert since signature was created by a different address
        vm.expectRevert("EIP2612: invalid signature");
        // call Permit2Proxy with signature
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    /// Permit2 specific tests ///

    function test_user_can_call_diamond_with_own_permit2_signature() public {
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermit2TransferFromParamsSignedBypermit2User();

        // Execute
        vm.prank(permit2User);
        permit2Proxy.callDiamondWithPermit2(
            diamondCalldata,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_call_diamond_with_permit2_using_different_wallet_address()
        public
    {
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermit2TransferFromParamsSignedBypermit2User();

        // Execute
        vm.prank(USER_SENDER); // Not the original signer
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.callDiamondWithPermit2(
            diamondCalldata,
            permitTransferFrom,
            signature
        );
    }

    function test_can_call_diamond_with_permit2_plus_witness() public {
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermit2WitnessTransferFromParamsSignedBypermit2User();

        // Execute
        vm.prank(USER_SENDER); // Can be executed by anyone
        permit2Proxy.callDiamondWithPermit2Witness(
            diamondCalldata,
            permit2User,
            permitTransferFrom,
            signature
        );
    }

    function test_can_generate_a_valid_msg_hash_for_signing() public {
        bytes32 msgHash;
        bytes32 generatedMsgHash;
        (
            ,
            ,
            msgHash,

        ) = _getPermit2WitnessTransferFromParamsSignedBypermit2User();

        generatedMsgHash = permit2Proxy.getPermit2MsgHash(
            _getCalldataForBridging(),
            ADDRESS_USDC,
            defaultUSDCAmount,
            0,
            block.timestamp + 1000
        );

        assertEq(msgHash, generatedMsgHash);
    }

    function testRevert_cannot_call_diamond_single_with_same_signature_more_than_once()
        public
    {
        deal(ADDRESS_USDC, permit2User, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermit2WitnessTransferFromParamsSignedBypermit2User();

        // Execute x2
        permit2Proxy.callDiamondWithPermit2Witness(
            diamondCalldata,
            permit2User,
            permitTransferFrom,
            signature
        );
        vm.expectRevert(InvalidNonce.selector);
        permit2Proxy.callDiamondWithPermit2Witness(
            diamondCalldata,
            permit2User,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_set_different_calldata_than_intended() public {
        deal(ADDRESS_USDC, permit2User, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermit2WitnessTransferFromParamsSignedBypermit2User();

        bytes memory maliciousCalldata = hex"1337c0d3";

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.callDiamondWithPermit2Witness(
            maliciousCalldata,
            permit2User,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_use_permit2_signature_from_another_wallet()
        public
    {
        deal(ADDRESS_USDC, permit2User, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes32 msgHash;
        (
            diamondCalldata,
            permitTransferFrom,
            msgHash,

        ) = _getPermit2WitnessTransferFromParamsSignedBypermit2User();

        // Sign with a random key
        bytes memory signature = _signMsgHash(msgHash, 987654321);

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.callDiamondWithPermit2Witness(
            diamondCalldata,
            permit2User,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_transfer_more_tokens_than_intended() public {
        deal(ADDRESS_USDC, permit2User, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes32 msgHash;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            msgHash,
            signature
        ) = _getPermit2WitnessTransferFromParamsSignedBypermit2User();

        permitTransferFrom.permitted.amount += 1;

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.callDiamondWithPermit2Witness(
            diamondCalldata,
            permit2User,
            permitTransferFrom,
            signature
        );
    }

    /// The following test code was adapted from https://github.com/flood-protocol/permit2-nonce-finder/blob/7a4ac8a58d0b499308000b75ddb2384834f31fac/test/Permit2NonceFinder.t.sol

    function test_can_find_nonce() public {
        // We invalidate the first nonce to make sure it's not returned.
        // We pass a mask of 0...0011 to invalidate nonce 0 and 1.
        uniPermit2.invalidateUnorderedNonces(0, 3);
        assertEq(permit2Proxy.nextNonce(address(this)), 2);

        // Invalidate the first word minus 1 nonce
        uniPermit2.invalidateUnorderedNonces(0, type(uint256).max >> 1);
        // We should find the last nonce in the first word
        assertEq(permit2Proxy.nextNonce(address(this)), 255);
    }

    function test_can_find_nonce_after() public {
        // We want to start from the second word
        uint256 start = 256;
        // We invalidate the whole next word to make sure it's not returned.
        uniPermit2.invalidateUnorderedNonces(1, type(uint256).max);
        assertEq(permit2Proxy.nextNonceAfter(address(this), start), 512);

        // Invalidate the next word minus 1 nonce
        uniPermit2.invalidateUnorderedNonces(2, type(uint256).max >> 1);
        // We should find the first nonce in the third word
        assertEq(permit2Proxy.nextNonceAfter(address(this), 767), 768);

        // The first word is still accessible if we start from a lower nonce
        assertEq(permit2Proxy.nextNonceAfter(address(this), 1), 2);
    }

    function test_eip2612_flow_is_resistant_to_frontrun_attack()
        public
        returns (TestDataEIP2612 memory)
    {
        // Record initial balance
        uint256 initialBalance = ERC20(ADDRESS_USDC).balanceOf(permit2User);

        vm.startPrank(permit2User);

        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        TestDataEIP2612
            memory testdata = _getTestDataEIP2612SignedBypermit2User(
                ADDRESS_USDC,
                domainSeparator,
                block.timestamp + 1000
            );

        vm.stopPrank();

        vm.startPrank(address(0xA));
        // Attacker calls ERC20.permit directly
        ERC20Permit(ADDRESS_USDC).permit(
            permit2User, //victim address
            address(permit2Proxy),
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s
        );
        vm.stopPrank();

        vm.startPrank(permit2User);

        // User's TX should succeed
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            testdata.deadline,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );
        vm.stopPrank();

        // Verify tokens were moved from permit2User
        uint256 finalBalance = ERC20(ADDRESS_USDC).balanceOf(permit2User);
        assertEq(
            finalBalance,
            initialBalance - defaultUSDCAmount,
            "User balance should have decreased by defaultUSDCAmount"
        );

        return testdata;
    }

    function testRevert_FailsOnCustomErrorAndAllowance() public {
        // deploy a mock ERC20Permit token that reverts with custom error on permit
        MockPermitToken token = new MockPermitToken();
        address tokenAddress = address(token);

        vm.startPrank(permit2User);

        bytes memory callData = _getCalldataForBridging();

        // we don't care about the signature since permit will revert anyway
        vm.expectRevert(MockPermitToken.CustomPermitError.selector);
        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            defaultUSDCAmount,
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    function testRevert_FailsOnPanicDuringAllowance() public {
        MockPermitTokenPanic token = new MockPermitTokenPanic();

        address tokenAddress = address(token);

        vm.startPrank(permit2User);

        bytes memory callData = _getCalldataForBridging();

        // expect panic error (0x01 for assertion failure)
        vm.expectRevert(stdError.assertionError);
        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            defaultUSDCAmount,
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    function testRevert_FailsOnEmptyRevert() public {
        MockPermitTokenEmptyRevert token = new MockPermitTokenEmptyRevert();
        address tokenAddress = address(token);

        vm.startPrank(permit2User);
        bytes memory callData = _getCalldataForBridging();

        // Expect empty revert
        vm.expectRevert();

        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            defaultUSDCAmount,
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    function testRevert_FailsOnStringRevert() public {
        MockPermitTokenStringRevert token = new MockPermitTokenStringRevert();
        address tokenAddress = address(token);

        vm.startPrank(permit2User);
        bytes memory callData = _getCalldataForBridging();

        // Expect string revert
        vm.expectRevert("Custom error message");

        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            defaultUSDCAmount,
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    function testRevert_FailsOnRequireRevert() public {
        MockPermitTokenRequireRevert token = new MockPermitTokenRequireRevert();
        address tokenAddress = address(token);

        vm.startPrank(permit2User);
        bytes memory callData = _getCalldataForBridging();

        // Expect require revert
        vm.expectRevert("Test revert message");

        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            500, // Amount less than 1000 to trigger require
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    function testRevert_FailsOnAdditionOverflow() public {
        MockPermitTokenAdditionOverflow token = new MockPermitTokenAdditionOverflow();
        address tokenAddress = address(token);

        vm.startPrank(permit2User);
        bytes memory callData = _getCalldataForBridging();

        // Expect arithmetic overflow panic
        vm.expectRevert(stdError.arithmeticError);

        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            defaultUSDCAmount,
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    function testRevert_FailsOnDivisionByZero() public {
        MockPermitTokenDivisionByZero token = new MockPermitTokenDivisionByZero();
        address tokenAddress = address(token);

        vm.startPrank(permit2User);
        bytes memory callData = _getCalldataForBridging();

        // Expect arithmetic error (division by zero)
        vm.expectRevert(stdError.divisionError);

        permit2Proxy.callDiamondWithEIP2612Signature(
            tokenAddress,
            defaultUSDCAmount,
            block.timestamp + 1000,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.stopPrank();
    }

    /// Helper Functions ///

    function _getPermit2TransferFromParamsSignedBypermit2User()
        internal
        view
        returns (
            bytes memory diamondCalldata,
            ISignatureTransfer.PermitTransferFrom memory permitTransferFrom,
            bytes32 msgHash,
            bytes memory signature
        )
    {
        // Calldata
        diamondCalldata = _getCalldataForBridging();

        // Token Permissions
        ISignatureTransfer.TokenPermissions
            memory tokenPermissions = ISignatureTransfer.TokenPermissions(
                ADDRESS_USDC,
                defaultUSDCAmount
            );
        bytes32 permit = _getTokenPermissionsHash(tokenPermissions);

        // Nonce
        uint256 nonce = permit2Proxy.nextNonce(permit2User);

        // PermitTransferFrom
        msgHash = _getPermitTransferFromHash(
            uniPermit2.DOMAIN_SEPARATOR(),
            permit,
            address(permit2Proxy),
            nonce,
            block.timestamp + 1000
        );

        signature = _signMsgHash(msgHash, PRIVATE_KEY);

        permitTransferFrom = ISignatureTransfer.PermitTransferFrom(
            tokenPermissions,
            nonce,
            block.timestamp + 1000
        );
    }

    function _getPermit2WitnessTransferFromParamsSignedBypermit2User()
        internal
        view
        returns (
            bytes memory diamondCalldata,
            ISignatureTransfer.PermitTransferFrom memory permitTransferFrom,
            bytes32 msgHash,
            bytes memory signature
        )
    {
        // Token Permissions
        ISignatureTransfer.TokenPermissions
            memory tokenPermissions = ISignatureTransfer.TokenPermissions(
                ADDRESS_USDC,
                defaultUSDCAmount
            );
        bytes32 permit = _getTokenPermissionsHash(tokenPermissions);

        // Witness
        diamondCalldata = _getCalldataForBridging();
        Permit2Proxy.LiFiCall memory lifiCall = Permit2Proxy.LiFiCall(
            DIAMOND_ADDRESS,
            keccak256(diamondCalldata)
        );
        bytes32 witness = _getWitnessHash(lifiCall);

        // Nonce
        uint256 nonce = permit2Proxy.nextNonce(permit2User);

        // PermitTransferWithWitness
        msgHash = _getPermitWitnessTransferFromHash(
            uniPermit2.DOMAIN_SEPARATOR(),
            permit,
            address(permit2Proxy),
            nonce,
            block.timestamp + 1000,
            witness
        );

        signature = _signMsgHash(msgHash, PRIVATE_KEY);

        permitTransferFrom = ISignatureTransfer.PermitTransferFrom(
            tokenPermissions,
            nonce,
            block.timestamp + 1000
        );
    }

    function _signMsgHash(
        bytes32 msgHash,
        uint256 privateKey
    ) internal pure returns (bytes memory signature) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, msgHash);
        signature = bytes.concat(r, s, bytes1(v));
    }

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

    function _getTokenPermissionsHash(
        ISignatureTransfer.TokenPermissions memory tokenPermissions
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    PermitHash._TOKEN_PERMISSIONS_TYPEHASH,
                    tokenPermissions.token,
                    tokenPermissions.amount
                )
            );
    }

    function _getWitnessHash(
        Permit2Proxy.LiFiCall memory lifiCall
    ) internal view returns (bytes32) {
        return
            keccak256(abi.encode(permit2Proxy.WITNESS_TYPEHASH(), lifiCall));
    }

    function _getPermitTransferFromHash(
        bytes32 domainSeparator,
        bytes32 permit,
        address spender,
        uint256 nonce,
        uint256 deadline
    ) internal pure returns (bytes32) {
        bytes32 dataHash = keccak256(
            abi.encode(
                PermitHash._PERMIT_TRANSFER_FROM_TYPEHASH,
                permit,
                spender,
                nonce,
                deadline
            )
        );

        return
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, dataHash));
    }

    function _getPermitWitnessTransferFromHash(
        bytes32 domainSeparator,
        bytes32 permit,
        address spender,
        uint256 nonce,
        uint256 deadline,
        bytes32 witness
    ) internal view returns (bytes32) {
        bytes32 dataHash = keccak256(
            abi.encode(
                permitWithWitnessTypehash,
                permit,
                spender,
                nonce,
                deadline,
                witness
            )
        );

        return
            keccak256(abi.encodePacked("\x19\x01", domainSeparator, dataHash));
    }

    function _getTestDataEIP2612SignedBypermit2User(
        address tokenAddress,
        bytes32 domainSeparator,
        uint256 deadline
    ) internal view returns (TestDataEIP2612 memory testdata) {
        testdata.tokenAddress = tokenAddress;
        testdata.userWallet = permit2User;
        testdata.nonce = ERC20Permit(tokenAddress).nonces(testdata.userWallet);
        testdata.deadline = deadline;

        // generate approval data to be signed by user
        bytes32 digest = _generateEIP2612MsgHash(
            testdata.userWallet,
            address(permit2Proxy),
            defaultUSDCAmount,
            testdata.nonce,
            testdata.deadline,
            domainSeparator
        );

        // sign digest and return signature
        (testdata.v, testdata.r, testdata.s) = vm.sign(PRIVATE_KEY, digest);

        // get calldata for bridging (simple USDC bridging via PolygonBridge)
        testdata.diamondCalldata = _getCalldataForBridging();
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
}
