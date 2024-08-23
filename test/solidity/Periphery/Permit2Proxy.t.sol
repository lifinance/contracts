// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Test, console } from "forge-std/Test.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import { ERC20 } from "../utils/TestBase.sol";
import "forge-std/console.sol";

contract Permit2ProxyTest is Test {
    using PermitHash for ISignatureTransfer.PermitTransferFrom;
    address internal constant PERMIT2_ADDRESS =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant LINK_ADDRESS =
        0x514910771AF9Ca656af840dff83E8264EcF986CA;
    bytes32 internal PERMIT_WITH_WITNESS_TYPEHASH;

    Permit2Proxy internal permit2Proxy;

    ISignatureTransfer internal uniPermit2;
    uint256 internal PRIVATE_KEY = 0x1234567890;
    address internal USER;

    function setUp() public {
        uniPermit2 = ISignatureTransfer(PERMIT2_ADDRESS);
        permit2Proxy = new Permit2Proxy(uniPermit2);
        PERMIT_WITH_WITNESS_TYPEHASH = keccak256(
            abi.encodePacked(
                PermitHash._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
                permit2Proxy.WITNESS_TYPE_STRING()
            )
        );
        vm.createSelectFork(vm.envString("ETH_NODE_URI_MAINNET"), 20261175);
        USER = vm.addr(PRIVATE_KEY);
    }

    function test_can_call_diamond_single() public {
        // Token Permissions
        ISignatureTransfer.TokenPermissions
            memory tokenPermissions = ISignatureTransfer.TokenPermissions(
                LINK_ADDRESS, // LINK
                100 ether
            );
        bytes32 permit = getTokenPermissionsHash(tokenPermissions);

        // Witness
        Permit2Proxy.LIFICall memory lifiCall = Permit2Proxy.LIFICall(
            USER,
            address(0x11f1),
            keccak256(hex"d34db33f")
        );
        bytes32 witness = getWitnessHash(lifiCall);

        // PermitTransferWithWitness
        bytes32 msgHash = getPermitWitnessTransferFromHash(
            uniPermit2.DOMAIN_SEPARATOR(),
            permit,
            address(permit2Proxy),
            0,
            type(uint256).max,
            witness
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRIVATE_KEY, msgHash);
        bytes memory sig = bytes.concat(r, s, bytes1(v));

        deal(LINK_ADDRESS, USER, 10000 ether);
        // Approve to Permit2
        vm.prank(USER);
        ERC20(LINK_ADDRESS).approve(PERMIT2_ADDRESS, 100 ether);

        permit2Proxy.diamondCallSingle(
            USER,
            address(0x11f1),
            hex"d34db33f",
            USER,
            ISignatureTransfer.PermitTransferFrom(
                tokenPermissions,
                0,
                type(uint256).max
            ),
            sig
        );
    }

    function getTokenPermissionsHash(
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

    function getWitnessHash(
        Permit2Proxy.LIFICall memory lifiCall
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    permit2Proxy.WITNESS_TYPEHASH(),
                    lifiCall.tokenReceiver,
                    lifiCall.diamondAddress,
                    lifiCall.diamondCalldataHash
                )
            );
    }

    function getPermitWitnessTransferFromHash(
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
