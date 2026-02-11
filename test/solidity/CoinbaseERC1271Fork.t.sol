// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ISignatureTransfer } from "lib/Permit2/src/interfaces/ISignatureTransfer.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { IWhitelistManagerFacet } from "lifi/Interfaces/IWhitelistManagerFacet.sol";
import { IERC173 } from "lifi/Interfaces/IERC173.sol";
import { UniswapV2Router02 } from "./utils/Interfaces.sol";

/// @title CoinbaseERC1271Fork
/// @notice Fork test: EIP-7702 wallet delegating to Coinbase Smart Wallet (0x0001...397e72), then
///         validate ERC-1271. Uses a wallet we control: etch 0xef0100||implementation, initialize(owners),
///         then sign replay-safe hash (CoinbaseSmartWalletMessage(bytes32 hash), domain "Coinbase Smart Wallet"/"1")
///         and call isValidSignature(hash, abi.encode(ownerIndex, abi.encodePacked(r,s,v))).
///         Env: ETH_NODE_URI_ARBITRUM (optional PRIVATE_KEY for signer).
contract CoinbaseERC1271Fork is Test {
    error InitializeFailed();
    error WhaleTransferFailed();
    error ApproveViaExecuteFailed();
    error WalletShouldHaveUSDT(uint256 expected, uint256 actual);
    error IsValidSignatureCallFailed();
    error InvalidResultLength(uint256 length);

    address internal constant COINBASE_SMART_WALLET =
        0x000100abaad02f1cfC8Bbe32bD5a564817339E72;

    address internal constant USDT_ARBITRUM =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    /// @dev Known USDT holder on Arbitrum (e.g. exchange) for funding the test wallet.
    address internal constant USDT_WHALE_ARBITRUM =
        0xa656f7d2A93A6F5878AA768f24eB38Ec8C827fE2;
    address internal constant PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev Permit2Proxy on Arbitrum (used for callDiamondWithPermit2 fork test).
    address internal constant PERMIT2_PROXY_ARBITRUM =
        0xb18aa783983D7354F77690fc27bbEC11AAAe22B5;
    /// @dev Uniswap V2–style router on Arbitrum (TestBase.sol ADDRESS_UNISWAP_ARB).
    address internal constant UNISWAP_ARBITRUM =
        0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    /// @dev USDC.e on Arbitrum (TestBase.sol ADDRESS_USDC_ARB); swap target for USDT -> USDC.
    address internal constant USDC_ARBITRUM =
        0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8;

    bytes32 internal constant COINBASE_MESSAGE_TYPEHASH =
        keccak256("CoinbaseSmartWalletMessage(bytes32 hash)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

    // Permit2 (SignatureTransfer) EIP-712: domain has no version
    bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,uint256 chainId,address verifyingContract)"
        );
    bytes32 internal constant PERMIT2_TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant PERMIT2_PERMIT_TRANSFER_FROM_TYPEHASH =
        keccak256(
            "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
        );

    uint256 internal walletPrivateKey;
    address internal wallet;

    function setUp() public {
        walletPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(
                0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
            )
        );
        wallet = vm.addr(walletPrivateKey);

        string memory rpcUrl = vm.envOr(
            "ETH_NODE_URI_ARBITRUM",
            string("https://arb1.arbitrum.io/rpc")
        );
        vm.createSelectFork(rpcUrl);

        vm.label(wallet, "Signer_Wallet");
        vm.label(USDT_ARBITRUM, "USDT_ARBITRUM");
        vm.label(USDT_WHALE_ARBITRUM, "USDT_WHALE_ARBITRUM");
        vm.label(PERMIT2, "PERMIT2");
        vm.label(PERMIT2_PROXY_ARBITRUM, "PERMIT2_PROXY_ARBITRUM");

        _setDelegationAndInitialize();
    }

    /// @dev Set EOA code to EIP-7702 delegation (0xef0100 || implementation) and call initialize(owners).
    function _setDelegationAndInitialize() internal {
        bytes memory delegationCode = abi.encodePacked(
            hex"ef0100",
            COINBASE_SMART_WALLET
        );
        vm.etch(wallet, delegationCode);

        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(wallet);

        (bool ok, ) = wallet.call(
            abi.encodeWithSignature("initialize(bytes[])", owners)
        );
        if (!ok) revert InitializeFailed();
    }

    /// @notice Replay-safe hash as used by Coinbase Smart Wallet ERC1271 (domain name "Coinbase Smart Wallet", version "1").
    function _replaySafeHash(
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

    /// @notice Coinbase Smart Wallet expects signature = abi.encode(SignatureWrapper(ownerIndex, abi.encodePacked(r,s,v))).
    function _encodeSignature(
        uint256 ownerIndex,
        bytes memory sigRsv
    ) internal pure returns (bytes memory) {
        return abi.encode(ownerIndex, sigRsv);
    }

    /// @notice Compute Permit2 (SignatureTransfer) EIP-712 digest. Spender must be the caller of permitTransferFrom.
    function _permit2Digest(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address spender
    ) internal view returns (bytes32) {
        bytes32 tokenPermissionsHash = keccak256(
            abi.encode(PERMIT2_TOKEN_PERMISSIONS_TYPEHASH, token, amount)
        );
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT2_PERMIT_TRANSFER_FROM_TYPEHASH,
                tokenPermissionsHash,
                spender,
                nonce,
                deadline
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                PERMIT2_DOMAIN_TYPEHASH,
                keccak256("Permit2"),
                block.chainid,
                PERMIT2
            )
        );
        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator, structHash)
            );
    }

    /// @dev Fund wallet with USDT via whale transfer and approve Permit2.
    function _fundWalletAndApprovePermit2() internal {
        uint256 amount = 1000 * 1e6; // 1000 USDT (6 decimals)
        vm.prank(USDT_WHALE_ARBITRUM);
        if (!IERC20(USDT_ARBITRUM).transfer(wallet, amount))
            revert WhaleTransferFailed();

        bytes memory approveCalldata = abi.encodeWithSelector(
            bytes4(keccak256("approve(address,uint256)")),
            PERMIT2,
            type(uint256).max
        );
        vm.prank(wallet);
        (bool ok, ) = wallet.call(
            abi.encodeWithSignature(
                "execute(address,uint256,bytes)",
                USDT_ARBITRUM,
                0,
                approveCalldata
            )
        );
        if (!ok) revert ApproveViaExecuteFailed();

        uint256 walletBalance = IERC20(USDT_ARBITRUM).balanceOf(wallet);
        if (walletBalance != amount)
            revert WalletShouldHaveUSDT(amount, walletBalance);
    }

    function testFork_CoinbaseERC1271_IsValidSignature_ReturnsMagicValue()
        public
    {
        bytes32 hash = keccak256("LiFi ERC1271 test");
        bytes32 messageHash = _replaySafeHash(wallet, hash);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            walletPrivateKey,
            messageHash
        );
        bytes memory signatureData = abi.encodePacked(r, s, v);
        bytes memory signature = _encodeSignature(0, signatureData);

        (bool success, bytes memory result) = wallet.staticcall(
            abi.encodeWithSignature(
                "isValidSignature(bytes32,bytes)",
                hash,
                signature
            )
        );

        if (!success) revert IsValidSignatureCallFailed();
        if (result.length < 4) revert InvalidResultLength(result.length);

        bytes4 magic = bytes4(result);
        assertEq(magic, bytes4(0x1626ba7e), "expected ERC1271 magic value");
    }

    /// @notice With Permit2 params for USDT, wallet.isValidSignature(permit2Digest, signature) returns magic value.
    function testFork_CoinbaseERC1271_Permit2Digest_IsValidSignature_ReturnsMagicValue()
        public
    {
        uint256 amount = 100 * 1e6;
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0;
        bytes32 digest = _permit2Digest(
            USDT_ARBITRUM,
            amount,
            nonce,
            deadline,
            address(this)
        );
        bytes memory signature = _signPermit2Permit(
            USDT_ARBITRUM,
            amount,
            nonce,
            deadline
        );

        (bool success, bytes memory result) = wallet.staticcall(
            abi.encodeWithSignature(
                "isValidSignature(bytes32,bytes)",
                digest,
                signature
            )
        );
        if (!success) revert IsValidSignatureCallFailed();

        assertEq(
            bytes4(result),
            bytes4(0x1626ba7e),
            "expected ERC1271 magic for Permit2 digest"
        );
    }

    /// @notice Register a Permit2 permit for USDT: wallet signs, we call permitTransferFrom; validates ERC-1271 via Permit2.
    /// @dev Requires wallet to have USDT (funded via whale in _fundWalletAndApprovePermit2).
    function testFork_CoinbaseERC1271_Permit2TransferFrom_USDT() public {
        _fundWalletAndApprovePermit2();

        uint256 amount = 100 * 1e6; // 100 USDT
        uint256 deadline = block.timestamp + 1 days;
        // Use a high nonce so it is unused on the forked chain (avoids InvalidNonce if 0 was already used).
        uint256 nonce = 0x1234_5678_9abc_def0;
        address recipient = address(uint160(0x1234)); // fresh so pre-balance 0 on fork
        assertEq(
            IERC20(USDT_ARBITRUM).balanceOf(recipient),
            0,
            "recipient should not have USDT"
        );

        ISignatureTransfer.PermitTransferFrom
            memory permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: USDT_ARBITRUM,
                    amount: amount
                }),
                nonce: nonce,
                deadline: deadline
            });
        ISignatureTransfer.SignatureTransferDetails
            memory transferDetails = ISignatureTransfer
                .SignatureTransferDetails({
                    to: recipient,
                    requestedAmount: amount
                });

        bytes memory signature = _signPermit2Permit(
            USDT_ARBITRUM,
            amount,
            nonce,
            deadline
        );

        ISignatureTransfer(PERMIT2).permitTransferFrom(
            permit,
            transferDetails,
            wallet,
            signature
        );

        assertEq(
            IERC20(USDT_ARBITRUM).balanceOf(recipient),
            amount,
            "recipient should have USDT"
        );
    }

    function _signPermit2Permit(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        return
            _signPermit2PermitForSpender(
                token,
                amount,
                nonce,
                deadline,
                address(this)
            );
    }

    /// @notice Same as _signPermit2Permit but with explicit spender (e.g. Permit2Proxy for callDiamondWithPermit2).
    function _signPermit2PermitForSpender(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address spender
    ) internal view returns (bytes memory) {
        bytes32 digest = _permit2Digest(
            token,
            amount,
            nonce,
            deadline,
            spender
        );
        bytes32 messageHash = _replaySafeHash(wallet, digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            walletPrivateKey,
            messageHash
        );
        return _encodeSignature(0, abi.encodePacked(r, s, v));
    }

    /// @notice Fork test: Coinbase 7702 wallet signs Permit2 permit with spender = Permit2Proxy,
    ///         then we call Permit2Proxy.callDiamondWithPermit2; validates full flow via proxy.
    function testFork_CoinbaseERC1271_Permit2Proxy_CallDiamondWithPermit2_USDT()
        public
    {
        _fundWalletAndApprovePermit2();

        uint256 amount = 100 * 1e6; // 100 USDT
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0x5678_9abc_def0_1234; // high nonce, unused on fork

        ISignatureTransfer.PermitTransferFrom
            memory permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: USDT_ARBITRUM,
                    amount: amount
                }),
                nonce: nonce,
                deadline: deadline
            });

        bytes memory signature = _signPermit2PermitForSpender(
            USDT_ARBITRUM,
            amount,
            nonce,
            deadline,
            PERMIT2_PROXY_ARBITRUM
        );

        // Minimal diamond calldata: call facetAddress(selector) on the proxy's LIFI_DIAMOND (view, no state change).
        bytes memory diamondCalldata = abi.encodeWithSelector(
            IDiamondLoupe.facetAddress.selector,
            bytes4(0x1626ba7e) // ERC1271 magic value as example selector
        );

        vm.prank(wallet);
        IPermit2Proxy(PERMIT2_PROXY_ARBITRUM).callDiamondWithPermit2(
            diamondCalldata,
            permit,
            signature
        );

        // Proxy should have received the USDT (then approved diamond); assert proxy balance or diamond call succeeded.
        assertEq(
            IERC20(USDT_ARBITRUM).balanceOf(PERMIT2_PROXY_ARBITRUM),
            amount,
            "Permit2Proxy should hold USDT after permit transfer"
        );
    }

    /// @notice Fork test: Permit2Proxy + GenericSwapFacetV3 swap (USDT -> USDC via Uniswap on Arbitrum).
    /// @dev Pranks diamond owner to whitelist Uniswap + swapExactTokensForTokens; then runs permit + swap; asserts wallet receives USDC.
    function testFork_CoinbaseERC1271_Permit2Proxy_CallDiamondWithPermit2_USDT_MinimalSwap()
        public
    {
        _fundWalletAndApprovePermit2();

        uint256 amount = 100 * 1e6; // 100 USDT
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0x9abc_def0_1234_5678;

        ISignatureTransfer.PermitTransferFrom
            memory permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: USDT_ARBITRUM,
                    amount: amount
                }),
                nonce: nonce,
                deadline: deadline
            });

        bytes memory signature = _signPermit2PermitForSpender(
            USDT_ARBITRUM,
            amount,
            nonce,
            deadline,
            PERMIT2_PROXY_ARBITRUM
        );

        address lifiDiamond = IPermit2ProxyView(PERMIT2_PROXY_ARBITRUM)
            .LIFI_DIAMOND();

        // Whitelist Uniswap + swapExactTokensForTokens so GenericSwapFacetV3 can call it.
        address diamondOwner = IERC173(lifiDiamond).owner();
        vm.prank(diamondOwner);
        IWhitelistManagerFacet(lifiDiamond).setContractSelectorWhitelist(
            UNISWAP_ARBITRUM,
            UniswapV2Router02.swapExactTokensForTokens.selector,
            true
        );

        (
            bytes memory diamondCalldata,
            uint256 minAmountOut
        ) = _buildSwapTokensGenericCalldata(lifiDiamond, amount);

        uint256 receiverUsdcBefore = IERC20(USDC_ARBITRUM).balanceOf(wallet);

        vm.prank(wallet);
        IPermit2Proxy(PERMIT2_PROXY_ARBITRUM).callDiamondWithPermit2(
            diamondCalldata,
            permit,
            signature
        );

        uint256 receiverUsdcAfter = IERC20(USDC_ARBITRUM).balanceOf(wallet);
        assertGt(
            receiverUsdcAfter,
            receiverUsdcBefore,
            "wallet should receive USDC from swap"
        );
        assertGe(
            receiverUsdcAfter - receiverUsdcBefore,
            minAmountOut,
            "output >= minAmountOut"
        );
    }

    /// @dev Builds calldata for GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20: one hop USDT -> USDC via Uniswap on Arbitrum.
    function _buildSwapTokensGenericCalldata(
        address lifiDiamond,
        uint256 amountIn
    )
        internal
        view
        returns (bytes memory diamondCalldata, uint256 minAmountOut)
    {
        address[] memory path = new address[](2);
        path[0] = USDT_ARBITRUM;
        path[1] = USDC_ARBITRUM;

        minAmountOut = UniswapV2Router02(UNISWAP_ARBITRUM).getAmountsOut(
            amountIn,
            path
        )[1];

        uint256 swapDeadline = block.timestamp + 20 minutes;
        bytes memory swapCallData = abi.encodeWithSelector(
            UniswapV2Router02.swapExactTokensForTokens.selector,
            amountIn,
            minAmountOut,
            path,
            lifiDiamond,
            swapDeadline
        );

        LibSwap.SwapData memory swapData = LibSwap.SwapData({
            callTo: UNISWAP_ARBITRUM,
            approveTo: UNISWAP_ARBITRUM,
            sendingAssetId: USDT_ARBITRUM,
            receivingAssetId: USDC_ARBITRUM,
            fromAmount: amountIn,
            callData: swapCallData,
            requiresDeposit: true
        });

        diamondCalldata = abi.encodeWithSelector(
            GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            bytes32(0),
            "integrator",
            "referrer",
            payable(wallet),
            minAmountOut,
            swapData
        );
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @dev Read LIFI_DIAMOND from Permit2Proxy (for swap recipient and building swap calldata).
interface IPermit2ProxyView {
    function LIFI_DIAMOND() external view returns (address);
}

/// @dev Minimal interface for Permit2Proxy.callDiamondWithPermit2.
interface IPermit2Proxy {
    function callDiamondWithPermit2(
        bytes calldata _diamondCalldata,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable returns (bytes memory);
}

/// @dev Used to build minimal diamond calldata (view call) for the fork test.
interface IDiamondLoupe {
    function facetAddress(
        bytes4 _functionSelector
    ) external view returns (address facetAddress_);
}
