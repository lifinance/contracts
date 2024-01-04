// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, TestBase, DSTest, ILiFi, console } from "../utils/TestBase.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { ISignatureTransfer } from "lifi/interfaces/ISignatureTransfer.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";

interface IPermit2 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

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

    bytes32 constant FULL_EXAMPLE_WITNESS_TYPEHASH =
        keccak256(
            "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)"
        );

    bytes32 constant FULL_EXAMPLE_WITNESS_BATCH_TYPEHASH =
        keccak256(
            "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)"
        );

    bytes32 public constant _TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");

    Permit2Proxy public p2Proxy;
    bytes32 public PERMIT2_DOMAIN_SEPARATOR;
    uint256 private _privKeyUserWallet;
    uint256 private _privKeyInvalidSignerWallet;
    address public addressUserWallet;

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

    struct PermitWitnessSingleCalldata {
        ISignatureTransfer.PermitTransferFrom permit;
        uint256 amount;
        bytes witnessData;
        address senderAddress;
        bytes signature;
    }

    function setUp() public {
        customBlockNumberForForking = 18931144;
        initTestBase();

        // store privKey and address of test user
        _privKeyUserWallet = 0x12341234;
        _privKeyInvalidSignerWallet = 0x12341235;
        addressUserWallet = vm.addr(_privKeyUserWallet);

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

        // deal USDC to user wallet
        deal(ADDRESS_USDC, addressUserWallet, defaultUSDCAmount);

        // max approve USDC to Permit2 contract
        vm.startPrank(addressUserWallet);
        usdc.approve(PERMIT2ADDRESS, type(uint256).max);
        vm.stopPrank();
    }

    /// Test Cases ///

    function testRevert_CannotUseSignatureTwice() public {
        // prepare calldata, sign it,
        PermitWitnessSingleCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        p2Proxy.gaslessWitnessDiamondCallSingleToken(
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
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevert_DoesNotAllowToTransferTokensToDifferentAddress()
        public
    {
        // prepare calldata & sign it
        PermitWitnessSingleCalldata
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
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevert_DoesNotAllowToExecuteCalldataOnDifferentDiamondAddress()
        public
    {
        // prepare calldata & sign it
        PermitWitnessSingleCalldata
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
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevert_DoesNotAllowToExecuteDifferentCalldata() public {
        // prepare calldata & sign it
        PermitWitnessSingleCalldata
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
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevert_WillNotAcceptSignatureFromOtherWallet() public {
        // prepare calldata & sign it
        PermitWitnessSingleCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // replace signature with signature from another wallet (same data)
        callData.signature = _getPermitWitnessTransferSignature(
            callData.permit,
            _privKeyInvalidSignerWallet,
            FULL_EXAMPLE_WITNESS_TYPEHASH,
            keccak256(callData.witnessData),
            PERMIT2_DOMAIN_SEPARATOR
        );

        // expect error to be thrown
        vm.expectRevert(InvalidSigner.selector);

        // call Permit2Proxy
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevert_CannotTransferMoreThanAllowed() public {
        // prepare calldata & sign it
        PermitWitnessSingleCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // expect error to be thrown
        vm.expectRevert(
            abi.encodePacked(InvalidAmount.selector, callData.amount)
        );

        // call Permit2Proxy
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount + 1,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function test_CanExecuteCalldataOnDiamondUsingPermit2() public {
        // prepare calldata, sign it,
        PermitWitnessSingleCalldata
            memory callData = _getPermitWitnessSingleCalldata();

        // expect event to be emitted by diamond
        vm.expectEmit(true, true, true, true, LIFIDIAMOND);
        emit LiFiTransferStarted(bridgeData);

        // call Permit2Proxy
        p2Proxy.gaslessWitnessDiamondCallSingleToken(
            callData.permit,
            callData.amount,
            callData.witnessData,
            callData.senderAddress,
            callData.signature
        );
    }

    function testRevert_NonOwnerCannotUpdateWhitelist() public {
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

    function testRevert_OwnerCanUpdateWhitelist() public {
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

    function _defaultERC20PermitWitnessTransfer(
        address token0,
        uint256 amount,
        uint256 nonce
    ) internal view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: token0,
                    amount: amount
                }),
                nonce: nonce,
                deadline: block.timestamp + 100
            });
    }

    function _getPermitWitnessTransferSignature(
        ISignatureTransfer.PermitTransferFrom memory permit,
        uint256 privateKey,
        bytes32 typehash,
        bytes32 witness,
        bytes32 domainSeparator
    ) internal view returns (bytes memory sig) {
        bytes32 tokenPermissions = keccak256(
            abi.encode(_TOKEN_PERMISSIONS_TYPEHASH, permit.permitted)
        );

        bytes32 msgHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(
                    abi.encode(
                        typehash,
                        tokenPermissions,
                        address(p2Proxy),
                        permit.nonce,
                        permit.deadline,
                        witness
                    )
                )
            )
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, msgHash);

        return bytes.concat(r, s, bytes1(v));
    }

    function _getPermitWitnessSingleCalldata()
        internal
        view
        returns (PermitWitnessSingleCalldata memory permitCalldata)
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
        permitCalldata.signature = _getPermitWitnessTransferSignature(
            permitCalldata.permit,
            _privKeyUserWallet,
            FULL_EXAMPLE_WITNESS_TYPEHASH,
            witness,
            PERMIT2_DOMAIN_SEPARATOR
        );

        permitCalldata.amount = defaultUSDCAmount;
        permitCalldata.senderAddress = addressUserWallet;
    }
}
