// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { TestBase } from "../../utils/TestBase.sol";
import { ERC1271Wallet } from "../../utils/ERC1271Wallet.sol";
import { Permit2Proxy } from "lifi/Periphery/Permit2Proxy.sol";
import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { PolygonBridgeFacet } from "lifi/Facets/PolygonBridgeFacet.sol";

interface IPermit2ProxyView {
    function LIFI_DIAMOND() external view returns (address);
}

contract Permit2ProxyTest is TestBase {
    using PermitHash for ISignatureTransfer.PermitTransferFrom;

    /// Constants / Immutables ///

    address internal constant PERMIT2_ADDRESS =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint256 internal constant PRIVATE_KEY = 0x1234567890;
    address internal constant DIAMOND_ADDRESS =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    /// @dev Native USDC (Circle) on Arbitrum; supports EIP-3009. Use with Arbitrum fork for EIP-3009 tests.
    address internal constant ADDRESS_USDC_NATIVE_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    /// @dev Coinbase Smart Wallet implementation (EIP-7702); used for Coinbase wallet fork test.
    address internal constant COINBASE_SMART_WALLET =
        0x000100abaad02f1cfC8Bbe32bD5a564817339E72;
    /// @dev Permit2Proxy on Arbitrum; used to read LIFI_DIAMOND for Coinbase wallet fork test.
    address internal constant PERMIT2_PROXY_ARBITRUM =
        0xb18aa783983D7354F77690fc27bbEC11AAAe22B5;
    uint256 internal constant FORK_BLOCK_ARBITRUM = 410_000_000;
    bytes32 internal constant COINBASE_MESSAGE_TYPEHASH =
        keccak256("CoinbaseSmartWalletMessage(bytes32 hash)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
    /// @dev Selector for Diamond Loupe facetAddress(bytes4); used as calldata target so the Diamond returns a registered facet.
    bytes4 internal constant DIAMOND_SELECTOR_FACET_ADDRESS =
        IDiamondLoupe.facetAddress.selector;

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

    struct TestDataEIP3009 {
        address tokenAddress;
        address userWallet;
        uint256 amount;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
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
    /// @dev Used by testRevert_PropagatesTokenPermitRevert when mocking USDC.permit() revert.
    error CustomPermitError();
    error CoinbaseInitFailed();

    function setUp() public {
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

    function test_CanExecuteCalldataUsingEip2612SignatureUsdc()
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

    function testRevert_WhenCalledWithInvalidCalldata() public {
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

    function testRevert_CannotUseEip2612SignatureTwice() public {
        TestDataEIP2612
            memory testdata = test_CanExecuteCalldataUsingEip2612SignatureUsdc();

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

    function testRevert_CannotUseExpiredEip2612Signature() public {
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

    function testRevert_CannotUseInvalidEip2612Signature() public {
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
            testdata.v + 1, // invalid v value
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    function testRevert_SignAndCallUsingDifferentAddresses() public {
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

    /// @notice EIP2612 with contract signer: ERC1271 wallet holds real USDC (ADDRESS_USDC from TestBase),
    ///         owner EOA signs permit digest; wallet calls proxy. Uses real USDC from mainnet fork.
    function test_CanExecuteCalldataUsingEip2612ContractSignatureUsdc()
        public
    {
        ERC1271Wallet wallet = new ERC1271Wallet(permit2User, address(0));

        uint256 walletBalance = 10000 * 10 ** ERC20(ADDRESS_USDC).decimals();
        deal(ADDRESS_USDC, address(wallet), walletBalance);

        uint256 amount = defaultUSDCAmount;
        uint256 deadline = block.timestamp + 1000;
        uint256 nonce = ERC20Permit(ADDRESS_USDC).nonces(address(wallet));
        bytes32 domainSeparator = ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR();

        bytes32 digest = _generateEIP2612MsgHash(
            address(wallet),
            address(permit2Proxy),
            amount,
            nonce,
            deadline,
            domainSeparator
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRIVATE_KEY, digest);

        bytes memory diamondCalldata = _getCalldataForBridging();

        vm.prank(address(wallet));
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            amount,
            deadline,
            v,
            r,
            s,
            diamondCalldata
        );

        assertEq(
            ERC20(ADDRESS_USDC).balanceOf(address(permit2Proxy)),
            0,
            "proxy should not hold USDC after bridge"
        );
        assertEq(
            ERC20(ADDRESS_USDC).balanceOf(address(wallet)),
            walletBalance - amount,
            "wallet balance should decrease by amount"
        );
    }

    /// @notice EIP2612 with Coinbase Smart Wallet (EIP-7702): wallet holds native USDC on Arbitrum,
    ///         signs permit via ERC-1271 (bytes overload); uses in-test Permit2Proxy and Arbitrum fork.
    /// @dev Mirror of test_CanExecuteCalldataUsingEip2612ContractSignatureUsdc for Coinbase wallet; see CoinbaseERC1271Fork.t.sol.
    function test_CanExecuteCalldataUsingEip2612CoinbaseWalletUsdc() public {
        string memory rpcUrl = vm.envOr(
            "ETH_NODE_URI_ARBITRUM",
            string("https://arb1.arbitrum.io/rpc")
        );
        vm.createSelectFork(rpcUrl, FORK_BLOCK_ARBITRUM);

        _setCoinbaseDelegationAndInitialize(permit2User);

        uint256 amount = 100 * 1e6;
        uint256 walletBalance = 1000 * 1e6;
        deal(ADDRESS_USDC_NATIVE_ARBITRUM, permit2User, walletBalance);

        address lifiDiamond = IPermit2ProxyView(PERMIT2_PROXY_ARBITRUM)
            .LIFI_DIAMOND();
        Permit2Proxy proxyWithBytes = new Permit2Proxy(
            lifiDiamond,
            ISignatureTransfer(PERMIT2_ADDRESS),
            address(this)
        );

        (
            bytes memory signature,
            bytes memory diamondCalldata
        ) = _getCoinbaseEip2612SignatureAndCalldata(
                permit2User,
                address(proxyWithBytes),
                ADDRESS_USDC_NATIVE_ARBITRUM,
                amount,
                block.timestamp + 1 days
            );

        vm.prank(permit2User);
        proxyWithBytes.callDiamondWithEIP2612Signature(
            ADDRESS_USDC_NATIVE_ARBITRUM,
            amount,
            block.timestamp + 1 days,
            signature,
            diamondCalldata
        );

        assertEq(
            ERC20(ADDRESS_USDC_NATIVE_ARBITRUM).balanceOf(
                address(proxyWithBytes)
            ),
            amount,
            "proxy should hold USDC after EIP2612 permit"
        );
        assertEq(
            ERC20(ADDRESS_USDC_NATIVE_ARBITRUM).balanceOf(permit2User),
            walletBalance - amount,
            "wallet balance should decrease by amount"
        );
    }

    /// Permit2 specific tests ///

    function test_UserCanCallDiamondWithOwnPermit2Signature() public {
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

    function testRevert_CannotCallDiamondWithPermit2UsingDifferentWalletAddress()
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

    function test_CanCallDiamondWithPermit2PlusWitness() public {
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

    function test_CanGenerateAValidMsgHashForSigning() public {
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

    function testRevert_CannotCallDiamondSingleWithSameSignatureMoreThanOnce()
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

    function testRevert_CannotSetDifferentCalldataThanIntended() public {
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

    function testRevert_CannotUsePermit2SignatureFromAnotherWallet() public {
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

    function testRevert_CannotTransferMoreTokensThanIntended() public {
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

    function test_CanFindNonce() public {
        // We invalidate the first nonce to make sure it's not returned.
        // We pass a mask of 0...0011 to invalidate nonce 0 and 1.
        uniPermit2.invalidateUnorderedNonces(0, 3);
        assertEq(permit2Proxy.nextNonce(address(this)), 2);

        // Invalidate the first word minus 1 nonce
        uniPermit2.invalidateUnorderedNonces(0, type(uint256).max >> 1);
        // We should find the last nonce in the first word
        assertEq(permit2Proxy.nextNonce(address(this)), 255);
    }

    function test_CanFindNonceAfter() public {
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

    function test_Eip2612FlowIsResistantToFrontrunAttack()
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

    /// @dev Uses vm.mockCallRevert so mainnet USDC's permit() reverts; proves the proxy propagates token permit reverts (no mock contract).
    function testRevert_PropagatesTokenPermitRevert() public {
        vm.startPrank(permit2User);

        bytes memory callData = _getCalldataForBridging();
        uint256 deadline = block.timestamp + 1000;

        // Next permit() call to USDC will revert with CustomPermitError (prefix match on selector).
        vm.mockCallRevert(
            ADDRESS_USDC,
            abi.encodeWithSelector(ERC20Permit.permit.selector),
            abi.encodeWithSelector(CustomPermitError.selector)
        );

        vm.expectRevert(CustomPermitError.selector);
        permit2Proxy.callDiamondWithEIP2612Signature(
            ADDRESS_USDC,
            defaultUSDCAmount,
            deadline,
            27, // dummy v
            bytes32(0), // dummy r
            bytes32(0), // dummy s
            callData
        );

        vm.clearMockedCalls();
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

    /// @dev Coinbase Smart Wallet replay-safe hash (domain "Coinbase Smart Wallet", version "1").
    function _coinbaseReplaySafeHash(
        address account,
        bytes32 hash
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("Coinbase Smart Wallet"),
                keccak256("1"),
                block.chainid,
                account
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(COINBASE_MESSAGE_TYPEHASH, hash)
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator, structHash)
            );
    }

    /// @dev Build Coinbase-format EIP2612 signature and dummy diamond calldata for fork test.
    function _getCoinbaseEip2612SignatureAndCalldata(
        address owner,
        address spender,
        address token,
        uint256 amount,
        uint256 deadline
    )
        internal
        view
        returns (bytes memory signature, bytes memory diamondCalldata)
    {
        uint256 nonce = ERC20Permit(token).nonces(owner);
        bytes32 domainSeparator = ERC20Permit(token).DOMAIN_SEPARATOR();
        bytes32 digest = _generateEIP2612MsgHash(
            owner,
            spender,
            amount,
            nonce,
            deadline,
            domainSeparator
        );
        bytes32 messageHash = _coinbaseReplaySafeHash(owner, digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PRIVATE_KEY, messageHash);
        signature = abi.encode(0, abi.encodePacked(r, s, v));
        diamondCalldata = abi.encodeWithSelector(
            IDiamondLoupe.facetAddress.selector,
            DIAMOND_SELECTOR_FACET_ADDRESS
        );
    }

    /// @dev Set EIP-7702 delegation to Coinbase Smart Wallet and initialize with single owner.
    function _setCoinbaseDelegationAndInitialize(address account) internal {
        bytes memory delegationCode = abi.encodePacked(
            hex"ef0100",
            COINBASE_SMART_WALLET
        );
        vm.etch(account, delegationCode);

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(account);
        (bool ok, ) = account.call(
            abi.encodeWithSelector(
                bytes4(keccak256("initialize(bytes[])")),
                owners
            )
        );
        if (!ok) revert CoinbaseInitFailed();
    }

    bytes32 internal constant EIP3009_RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    function _generateEIP3009ReceiveWithAuthorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes32 domainSeparator
    ) internal pure returns (bytes32 digest) {
        bytes32 structHash = keccak256(
            abi.encode(
                EIP3009_RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
    }

    function _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
        address tokenAddress,
        bytes32 domainSeparator,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (TestDataEIP3009 memory testdata) {
        testdata.tokenAddress = tokenAddress;
        testdata.userWallet = permit2User;
        testdata.amount = amount;
        testdata.validAfter = validAfter;
        testdata.validBefore = validBefore;
        testdata.nonce = nonce;

        bytes32 digest = _generateEIP3009ReceiveWithAuthorizationDigest(
            permit2User,
            address(permit2Proxy),
            amount,
            validAfter,
            validBefore,
            nonce,
            domainSeparator
        );

        (testdata.v, testdata.r, testdata.s) = vm.sign(PRIVATE_KEY, digest);
        testdata.diamondCalldata = _getCalldataForBridging();
    }

    /// EIP-3009 receiveWithAuthorization tests ///

    /// @dev Uses mainnet fork USDC (ADDRESS_USDC) which implements EIP-3009 receiveWithAuthorization.
    function test_CanExecuteCalldataUsingEip3009ReceiveAuth()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            permit2User,
            -int256(defaultUSDCAmount)
        )
    {
        vm.startPrank(permit2User);

        TestDataEIP3009
            memory testdata = _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
                ADDRESS_USDC,
                ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR(),
                defaultUSDCAmount,
                block.timestamp - 1,
                block.timestamp + 1000,
                keccak256(
                    abi.encodePacked(
                        permit2User,
                        block.timestamp,
                        "eip3009-receive"
                    )
                )
            );

        vm.expectEmit(true, true, true, true, DIAMOND_ADDRESS);
        emit LiFiTransferStarted(bridgeData);

        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            testdata.amount,
            testdata.validAfter,
            testdata.validBefore,
            testdata.nonce,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );
        vm.stopPrank();
    }

    function testRevert_CannotUseEip3009ReceiveAuthTwice() public {
        vm.startPrank(permit2User);

        bytes32 nonce = keccak256(
            abi.encodePacked(
                permit2User,
                block.timestamp,
                "eip3009-receive-twice"
            )
        );
        TestDataEIP3009
            memory testdata = _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
                ADDRESS_USDC,
                ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR(),
                defaultUSDCAmount,
                block.timestamp - 1,
                block.timestamp + 1000,
                nonce
            );

        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            testdata.amount,
            testdata.validAfter,
            testdata.validBefore,
            testdata.nonce,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            testdata.amount,
            testdata.validAfter,
            testdata.validBefore,
            testdata.nonce,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    /// @dev Uses mainnet fork USDC; validBefore in the past triggers FiatTokenV2 expiration revert.
    function testRevert_CannotUseExpiredEip3009ReceiveAuth() public {
        TestDataEIP3009
            memory testdata = _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
                ADDRESS_USDC,
                ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR(),
                defaultUSDCAmount,
                block.timestamp - 100,
                block.timestamp - 1,
                keccak256(abi.encodePacked(permit2User, "expired-receive"))
            );

        vm.startPrank(permit2User);

        vm.expectRevert("FiatTokenV2: authorization is expired");
        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            testdata.amount,
            testdata.validAfter,
            testdata.validBefore,
            testdata.nonce,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );

        vm.stopPrank();
    }

    /// @dev Uses mainnet fork USDC; invalid calldata causes diamond to revert, proxy wraps as CallToDiamondFailed.
    function testRevert_WhenCalledWithInvalidCalldataEip3009ReceiveAuth()
        public
    {
        TestDataEIP3009
            memory testdata = _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
                ADDRESS_USDC,
                ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR(),
                defaultUSDCAmount,
                block.timestamp - 1,
                block.timestamp + 1000,
                keccak256(
                    abi.encodePacked(permit2User, "invalid-calldata-receive")
                )
            );

        vm.startPrank(permit2User);

        vm.expectRevert(
            abi.encodeWithSignature(
                "CallToDiamondFailed(bytes)",
                hex"a9ad62f8"
            )
        );
        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            testdata.amount,
            testdata.validAfter,
            testdata.validBefore,
            testdata.nonce,
            testdata.v,
            testdata.r,
            testdata.s,
            hex"1337c0d3"
        );

        vm.stopPrank();
    }

    /// @dev Covers callDiamondWithEIP3009Signature(..., bytes signature) with mainnet USDC; full flow succeeds.
    function test_CanExecuteCalldataUsingEip3009ReceiveAuthBytes()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            permit2User,
            -int256(defaultUSDCAmount)
        )
    {
        uint256 amount = defaultUSDCAmount;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1000;
        bytes32 nonce = keccak256(
            abi.encodePacked(permit2User, "receive-bytes")
        );

        TestDataEIP3009
            memory testdata = _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
                ADDRESS_USDC,
                ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR(),
                amount,
                validAfter,
                validBefore,
                nonce
            );

        bytes memory signature = abi.encodePacked(
            testdata.r,
            testdata.s,
            bytes1(testdata.v)
        );

        vm.startPrank(permit2User);

        vm.expectEmit(true, true, true, true, DIAMOND_ADDRESS);
        emit LiFiTransferStarted(bridgeData);

        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            amount,
            validAfter,
            validBefore,
            nonce,
            signature,
            testdata.diamondCalldata
        );
        vm.stopPrank();
    }

    /// @dev Uses mainnet USDC. Proxy passes msg.sender as `from`; when caller is not the signer, token reverts with invalid signature.
    function testRevert_Eip3009ReceiveAuthWrongCallerReverts() public {
        TestDataEIP3009
            memory testdata = _getTestDataEIP3009ReceiveAuthSignedBypermit2User(
                ADDRESS_USDC,
                ERC20Permit(ADDRESS_USDC).DOMAIN_SEPARATOR(),
                defaultUSDCAmount,
                block.timestamp - 1,
                block.timestamp + 1000,
                keccak256(abi.encodePacked(permit2User, "wrong-caller"))
            );

        vm.prank(USER_SENDER);

        vm.expectRevert("FiatTokenV2: invalid signature");
        permit2Proxy.callDiamondWithEIP3009Signature(
            ADDRESS_USDC,
            testdata.amount,
            testdata.validAfter,
            testdata.validBefore,
            testdata.nonce,
            testdata.v,
            testdata.r,
            testdata.s,
            testdata.diamondCalldata
        );
    }
}
