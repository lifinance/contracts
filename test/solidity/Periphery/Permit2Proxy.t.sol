// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Test, TestBase, DSTest, ILiFi, console, ERC20 } from "../utils/TestBase.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import { ERC20 } from "../utils/TestBase.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";

contract Permit2ProxyTest is TestBase {
    using PermitHash for ISignatureTransfer.PermitTransferFrom;

    /// Constants ///

    address internal constant PERMIT2_ADDRESS =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 internal PRIVATE_KEY = 0x1234567890;
    address internal constant DIAMOND_ADDRESS =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;

    /// Storage ///

    bytes32 internal PERMIT_WITH_WITNESS_TYPEHASH;
    Permit2Proxy internal permit2Proxy;
    ISignatureTransfer internal uniPermit2;
    address internal PERMIT2_USER;

    /// Errors ///

    error InvalidSigner();
    error InvalidNonce();

    function setUp() public {
        customBlockNumberForForking = 20261175;
        initTestBase();

        uniPermit2 = ISignatureTransfer(PERMIT2_ADDRESS);
        permit2Proxy = new Permit2Proxy(address(this), uniPermit2);
        PERMIT_WITH_WITNESS_TYPEHASH = keccak256(
            abi.encodePacked(
                PermitHash._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
                permit2Proxy.WITNESS_TYPE_STRING()
            )
        );

        address[] memory whitelist = new address[](1);
        whitelist[0] = DIAMOND_ADDRESS;
        bool[] memory allowed = new bool[](1);
        allowed[0] = true;
        permit2Proxy.updateWhitelist(whitelist, allowed);
        PERMIT2_USER = vm.addr(PRIVATE_KEY);
        vm.label(PERMIT2_USER, "Permit2 User");
        deal(ADDRESS_USDC, PERMIT2_USER, 10000 ether);

        // Infinite approve to Permit2
        vm.prank(PERMIT2_USER);
        ERC20(ADDRESS_USDC).approve(PERMIT2_ADDRESS, type(uint256).max);
    }

    function test_can_call_diamond_single() public {
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermitWitnessTransferFromParams();

        // Execute
        permit2Proxy.diamondCallSingle(
            DIAMOND_ADDRESS,
            diamondCalldata,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_call_diamond_single_with_same_signature_more_than_once()
        public
    {
        deal(ADDRESS_USDC, PERMIT2_USER, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermitWitnessTransferFromParams();

        // Execute x2
        permit2Proxy.diamondCallSingle(
            DIAMOND_ADDRESS,
            diamondCalldata,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
        vm.expectRevert(InvalidNonce.selector);
        permit2Proxy.diamondCallSingle(
            DIAMOND_ADDRESS,
            diamondCalldata,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_set_different_diamond_address_than_intended()
        public
    {
        deal(ADDRESS_USDC, PERMIT2_USER, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermitWitnessTransferFromParams();

        address MALICIOUS_CONTRACT;

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.diamondCallSingle(
            MALICIOUS_CONTRACT,
            diamondCalldata,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_set_different_calldata_than_intended() public {
        deal(ADDRESS_USDC, PERMIT2_USER, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes memory signature;
        (
            diamondCalldata,
            permitTransferFrom,
            ,
            signature
        ) = _getPermitWitnessTransferFromParams();

        bytes memory MALICIOUS_CALLDATA;

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.diamondCallSingle(
            DIAMOND_ADDRESS,
            MALICIOUS_CALLDATA,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_use_signature_from_another_wallet() public {
        deal(ADDRESS_USDC, PERMIT2_USER, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes32 msgHash;
        (
            diamondCalldata,
            permitTransferFrom,
            msgHash,

        ) = _getPermitWitnessTransferFromParams();

        bytes memory signature = _signMsgHash(msgHash, 987654321);

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.diamondCallSingle(
            DIAMOND_ADDRESS,
            diamondCalldata,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
    }

    function testRevert_cannot_transfer_more_tokens_than_intended() public {
        deal(ADDRESS_USDC, PERMIT2_USER, 10000 ether);
        bytes memory diamondCalldata;
        ISignatureTransfer.PermitTransferFrom memory permitTransferFrom;
        bytes32 msgHash;
        (
            diamondCalldata,
            permitTransferFrom,
            msgHash,

        ) = _getPermitWitnessTransferFromParams();

        bytes memory signature = _signMsgHash(msgHash, 987654321);

        permitTransferFrom.permitted.amount = 500 ether;

        // Execute
        vm.expectRevert(InvalidSigner.selector);
        permit2Proxy.diamondCallSingle(
            DIAMOND_ADDRESS,
            diamondCalldata,
            PERMIT2_USER,
            permitTransferFrom,
            signature
        );
    }

    /// Helper Functions ///

    function _getPermitWitnessTransferFromParams()
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
                ADDRESS_USDC, // LINK
                100 ether
            );
        bytes32 permit = _getTokenPermissionsHash(tokenPermissions);

        // Witness
        diamondCalldata = _getCalldataForBridging();
        Permit2Proxy.LIFICall memory lifiCall = Permit2Proxy.LIFICall(
            DIAMOND_ADDRESS,
            keccak256(diamondCalldata)
        );
        bytes32 witness = _getWitnessHash(lifiCall);

        // PermitTransferWithWitness
        msgHash = _getPermitWitnessTransferFromHash(
            uniPermit2.DOMAIN_SEPARATOR(),
            permit,
            address(permit2Proxy),
            0,
            type(uint256).max,
            witness
        );

        signature = _signMsgHash(msgHash, PRIVATE_KEY);

        permitTransferFrom = ISignatureTransfer.PermitTransferFrom(
            tokenPermissions,
            0,
            type(uint256).max
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
        Permit2Proxy.LIFICall memory lifiCall
    ) internal view returns (bytes32) {
        return
            keccak256(abi.encode(permit2Proxy.WITNESS_TYPEHASH(), lifiCall));
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
                PERMIT_WITH_WITNESS_TYPEHASH,
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
}
