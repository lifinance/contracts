// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ISignatureTransfer } from "lib/Permit2/src/interfaces/ISignatureTransfer.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { IWhitelistManagerFacet } from "lifi/Interfaces/IWhitelistManagerFacet.sol";
import { IERC173 } from "lifi/Interfaces/IERC173.sol";
import { IERC5267 } from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import { UniswapV2Router02 } from "../../utils/Interfaces.sol";

/// @title BaseERC1271Fork
/// @notice Fork test on Base: EIP-7702 wallet delegating to implementation 0x36d3...c0D, then validate ERC-1271.
///         Same flow as CoinbaseERC1271Fork (Arbitrum) but Base chain and delegation target 0x36d3CBD83961868398d056EfBf50f5CE15528c0D.
///         Env: ETH_NODE_URI_BASE (optional PRIVATE_KEY for signer).
/// @dev Demonstrates how to get a valid ERC-1271 signature: fetch EIP-712 domain via eip712Domain(), build replay-safe hash (domain + message struct type), sign, pass to isValidSignature.
///      USDT_WHALE_BASE must hold sufficient USDT on Base.
///      Wallet delegation exists only in fork state (vm.etch); cast call to wallet on Base cannot reproduce execute failures—
///      use forge test --match-test <name> -vvvv for full trace.
/// @dev Matches (address,uint256,bytes) for batch execute ABI.
struct BatchExecuteCall {
    address target;
    uint256 value;
    bytes data;
}

contract BaseERC1271Fork is Test {
    error WhaleTransferFailed();
    /// @dev Reverted when wallet execute (single or batch) returns false (we rethrow delegate return data when present).
    error ApproveViaExecuteFailed();
    error WalletShouldHaveUSDT(uint256 expected, uint256 actual);
    error IsValidSignatureCallFailed();
    error InvalidResultLength(uint256 length);

    /// @dev Delegation target on Base (wallet implementation for EIP-7702); different from Coinbase Smart Wallet on Arbitrum.
    address internal constant DELEGATION_TARGET_BASE =
        0x36d3CBD83961868398d056EfBf50f5CE15528c0D;

    /// @dev USDT on Base (matches TestBase ADDRESS_USDT_BASE).
    address internal constant USDT_BASE =
        0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;
    /// @dev USDT holder on Base for funding.
    address internal constant USDT_WHALE_BASE =
        0xb8C6A7E8B6970b7C33bC61455416F1EC8015a8cA;
    address internal constant PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant PERMIT2_PROXY_BASE =
        0xfaD2a4d7e19C4EDd5407a7F7673F01FE41431D51;
    /// @dev TestBase.sol ADDRESS_UNISWAP_BASE (Aerodrome / Uniswap-style router).
    address internal constant UNISWAP_BASE =
        0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891;
    address internal constant USDC_BASE =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev Pinned fork block so tests are deterministic (whale balance, liquidity, delegate 0x36d3... deployed at 35816553).
    uint256 internal constant FORK_BLOCK_BASE = 41_990_000;

    /// @dev Message struct type for EIP-712 replay-safe hash. Must match the delegator implementation.
    bytes32 internal constant COINBASE_MESSAGE_TYPEHASH =
        keccak256("CoinbaseSmartWalletMessage(bytes32 hash)");
    /// @dev Base delegator 0x36d3 reports name "SmartWallet"; use this message type for replay-safe hash.
    bytes32 internal constant SMART_WALLET_MESSAGE_TYPEHASH =
        keccak256("SmartWalletMessage(bytes32 hash)");
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

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
    /// @dev EIP-712 domain separator from delegator's eip712Domain(); 0 = use Coinbase default in _replaySafeHash.
    bytes32 internal fetchedDomainSeparator;
    /// @dev Message type hash for replay-safe hash; set from delegator name in _fetchDomainFromDelegator.
    bytes32 internal fetchedMessageTypeHash;

    /// @dev Set true to deactivate fork tests (e.g. for coverage); set false to re-enable. No vm.skip (older forge-std).
    bool internal constant _FORK_TESTS_DISABLED = true;

    function setUp() public {
        if (_FORK_TESTS_DISABLED) return;
        walletPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(
                0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
            )
        );
        wallet = vm.addr(walletPrivateKey);

        string memory rpcUrl = vm.envOr(
            "ETH_NODE_URI_BASE",
            string("https://mainnet.base.org")
        );
        vm.createSelectFork(rpcUrl, FORK_BLOCK_BASE);

        vm.label(wallet, "Signer_Wallet");
        vm.label(USDT_BASE, "USDT_BASE");
        vm.label(USDT_WHALE_BASE, "USDT_WHALE_BASE");
        vm.label(PERMIT2, "PERMIT2");
        vm.label(PERMIT2_PROXY_BASE, "PERMIT2_PROXY_BASE");

        _setDelegation();
        _fetchDomainFromDelegator();
    }

    /// @dev Set EIP-7702 delegation (0xef0100 || implementation). No initialize call; delegate may use EOA as implicit owner.
    function _setDelegation() internal {
        bytes memory delegationCode = abi.encodePacked(
            hex"ef0100",
            DELEGATION_TARGET_BASE
        );
        vm.etch(wallet, delegationCode);
    }

    /// @dev Fetch EIP-712 domain from delegator via eip712Domain() (EIP-5267) and set fetchedDomainSeparator for _replaySafeHash.
    ///      Tries wallet first (EIP-7702 delegatecall); if that fails, calls delegation target and uses wallet as verifyingContract.
    function _fetchDomainFromDelegator() internal {
        (bool ok, bytes memory ret) = wallet.staticcall(
            abi.encodeWithSelector(IERC5267.eip712Domain.selector)
        );
        if (!ok || ret.length == 0) {
            (ok, ret) = DELEGATION_TARGET_BASE.staticcall(
                abi.encodeWithSelector(IERC5267.eip712Domain.selector)
            );
        }
        if (!ok || ret.length == 0) return;

        (
            ,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            ,

        ) = abi.decode(
                ret,
                (bytes1, string, string, uint256, address, bytes32, uint256[])
            );

        if (verifyingContract != wallet) {
            verifyingContract = wallet;
        }
        fetchedDomainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
        fetchedMessageTypeHash = keccak256(bytes(name)) ==
            keccak256("SmartWallet")
            ? SMART_WALLET_MESSAGE_TYPEHASH
            : COINBASE_MESSAGE_TYPEHASH;
    }

    /// @notice Replay-safe hash for ERC-1271: EIP-712 hash of (domain, messageType, hash). Domain from eip712Domain(); message type must match delegator (see COINBASE_MESSAGE_TYPEHASH).
    function _replaySafeHash(
        address account,
        bytes32 hash
    ) internal view returns (bytes32) {
        bytes32 domainSeparator = fetchedDomainSeparator != bytes32(0)
            ? fetchedDomainSeparator
            : keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256("Coinbase Smart Wallet"),
                    keccak256("1"),
                    block.chainid,
                    account
                )
            );
        bytes32 messageTypeHash = fetchedMessageTypeHash != bytes32(0)
            ? fetchedMessageTypeHash
            : COINBASE_MESSAGE_TYPEHASH;
        bytes32 structHash = keccak256(abi.encode(messageTypeHash, hash));
        return
            keccak256(
                abi.encodePacked("\x19\x01", domainSeparator, structHash)
            );
    }

    function _encodeSignature(
        uint256 ownerIndex,
        bytes memory sigRsv
    ) internal pure returns (bytes memory) {
        return abi.encode(ownerIndex, sigRsv);
    }

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

    /// @dev Selector for execute((address,uint256,bytes)[]) — batch execute from wallet bytecode dispatch.
    bytes4 internal constant BATCH_EXECUTE_SELECTOR = 0x3f707e6b;

    /// @dev Fund wallet with USDT via whale and approve Permit2 using batch execute with one call.
    function _fundWalletAndApprovePermit2() internal {
        uint256 amount = 100 * 1e6; // 100 USDT (6 decimals); use 1000 if whale has sufficient balance
        vm.prank(USDT_WHALE_BASE);
        if (!IERC20(USDT_BASE).transfer(wallet, amount))
            revert WhaleTransferFailed();

        bytes memory approveCalldata = abi.encodeWithSelector(
            bytes4(keccak256("approve(address,uint256)")),
            PERMIT2,
            type(uint256).max
        );
        BatchExecuteCall[] memory calls = new BatchExecuteCall[](1);
        calls[0] = BatchExecuteCall({
            target: USDT_BASE,
            value: uint256(0),
            data: approveCalldata
        });

        vm.prank(wallet);
        (bool ok, bytes memory returnData) = wallet.call(
            abi.encodeWithSelector(BATCH_EXECUTE_SELECTOR, calls)
        );
        if (!ok) {
            if (returnData.length > 0) LibUtil.revertWith(returnData);
            revert ApproveViaExecuteFailed();
        }

        uint256 walletBalance = IERC20(USDT_BASE).balanceOf(wallet);
        if (walletBalance != amount)
            revert WalletShouldHaveUSDT(amount, walletBalance);
    }

    function testFork_BaseERC1271_IsValidSignature_ReturnsMagicValue() public {
        if (_FORK_TESTS_DISABLED) return;
        bytes32 hash = keccak256("LiFi ERC1271 test");
        bytes32 messageHash = _replaySafeHashFromWallet(hash);

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
    function testFork_BaseERC1271_Permit2Digest_IsValidSignature_ReturnsMagicValue()
        public
    {
        if (_FORK_TESTS_DISABLED) return;
        uint256 amount = 100 * 1e6;
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0;
        bytes32 digest = _permit2Digest(
            USDT_BASE,
            amount,
            nonce,
            deadline,
            address(this)
        );
        bytes memory signature = _signPermit2Permit(
            USDT_BASE,
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

    /// @notice Permit2 permit for USDT: wallet signs, we call permitTransferFrom.
    function testFork_BaseERC1271_Permit2TransferFrom_USDT() public {
        if (_FORK_TESTS_DISABLED) return;
        _fundWalletAndApprovePermit2();

        uint256 amount = 100 * 1e6; // 100 USDT
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0x1234_5678_9abc_def0;
        address recipient = address(uint160(0x1234));
        assertEq(
            IERC20(USDT_BASE).balanceOf(recipient),
            0,
            "recipient should not have USDT"
        );

        ISignatureTransfer.PermitTransferFrom
            memory permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: USDT_BASE,
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
            USDT_BASE,
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
            IERC20(USDT_BASE).balanceOf(recipient),
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
        // Use wallet's replaySafeHash when available so we sign exactly what the wallet will verify.
        bytes32 messageHash = _replaySafeHashFromWallet(digest);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            walletPrivateKey,
            messageHash
        );
        return _encodeSignature(0, abi.encodePacked(r, s, v));
    }

    /// @dev Get replay-safe hash from wallet if it exposes replaySafeHash(bytes32); else use local _replaySafeHash.
    function _replaySafeHashFromWallet(
        bytes32 hash
    ) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = wallet.staticcall(
            abi.encodeWithSignature("replaySafeHash(bytes32)", hash)
        );
        if (ok && ret.length >= 32) return abi.decode(ret, (bytes32));
        return _replaySafeHash(wallet, hash);
    }

    /// @notice Permit2Proxy.callDiamondWithPermit2 with minimal diamond calldata (view).
    function testFork_BaseERC1271_Permit2Proxy_CallDiamondWithPermit2_USDT()
        public
    {
        if (_FORK_TESTS_DISABLED) return;
        _fundWalletAndApprovePermit2();

        uint256 amount = 100 * 1e6; // 100 USDT
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0x5678_9abc_def0_1234;

        ISignatureTransfer.PermitTransferFrom
            memory permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: USDT_BASE,
                    amount: amount
                }),
                nonce: nonce,
                deadline: deadline
            });

        bytes memory signature = _signPermit2PermitForSpender(
            USDT_BASE,
            amount,
            nonce,
            deadline,
            PERMIT2_PROXY_BASE
        );

        bytes memory diamondCalldata = abi.encodeWithSelector(
            IDiamondLoupe.facetAddress.selector,
            bytes4(0x1626ba7e)
        );

        vm.prank(wallet);
        IPermit2Proxy(PERMIT2_PROXY_BASE).callDiamondWithPermit2(
            diamondCalldata,
            permit,
            signature
        );

        assertEq(
            IERC20(USDT_BASE).balanceOf(PERMIT2_PROXY_BASE),
            amount,
            "Permit2Proxy should hold USDT after permit transfer"
        );
    }

    /// @notice Fork test: Permit2Proxy + GenericSwapFacetV3 swap (USDT -> USDC via Uniswap-style router on Base).
    /// @dev Pranks diamond owner to whitelist router + swapExactTokensForTokens; then runs permit + swap; asserts wallet receives USDC.
    function testFork_BaseERC1271_Permit2Proxy_CallDiamondWithPermit2_USDT_MinimalSwap()
        public
    {
        if (_FORK_TESTS_DISABLED) return;
        _fundWalletAndApprovePermit2();

        uint256 amount = 100 * 1e6; // 100 USDT
        uint256 deadline = block.timestamp + 1 days;
        uint256 nonce = 0x9abc_def0_1234_5678;

        ISignatureTransfer.PermitTransferFrom
            memory permit = ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({
                    token: USDT_BASE,
                    amount: amount
                }),
                nonce: nonce,
                deadline: deadline
            });

        bytes memory signature = _signPermit2PermitForSpender(
            USDT_BASE,
            amount,
            nonce,
            deadline,
            PERMIT2_PROXY_BASE
        );

        address lifiDiamond = IPermit2ProxyView(PERMIT2_PROXY_BASE)
            .LIFI_DIAMOND();

        (
            bytes memory diamondCalldata,
            uint256 minAmountOut
        ) = _buildSwapTokensGenericCalldata(lifiDiamond, amount);

        address diamondOwner = IERC173(lifiDiamond).owner();
        vm.prank(diamondOwner);
        IWhitelistManagerFacet(lifiDiamond).setContractSelectorWhitelist(
            UNISWAP_BASE,
            UniswapV2Router02.swapExactTokensForTokens.selector,
            true
        );

        uint256 receiverUsdcBefore = IERC20(USDC_BASE).balanceOf(wallet);

        vm.prank(wallet);
        IPermit2Proxy(PERMIT2_PROXY_BASE).callDiamondWithPermit2(
            diamondCalldata,
            permit,
            signature
        );

        uint256 receiverUsdcAfter = IERC20(USDC_BASE).balanceOf(wallet);
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

    /// @dev Builds calldata for GenericSwapFacetV3.swapTokensSingleV3ERC20ToERC20: one hop USDT -> USDC on Base.
    ///      Reverts when getAmountsOut fails (e.g. pool unavailable at fork block).
    function _buildSwapTokensGenericCalldata(
        address lifiDiamond,
        uint256 amountIn
    )
        internal
        view
        returns (bytes memory diamondCalldata, uint256 minAmountOut)
    {
        address[] memory path = new address[](2);
        path[0] = USDT_BASE;
        path[1] = USDC_BASE;

        uint256[] memory amounts = UniswapV2Router02(UNISWAP_BASE)
            .getAmountsOut(amountIn, path);
        minAmountOut = amounts[1];

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
            callTo: UNISWAP_BASE,
            approveTo: UNISWAP_BASE,
            sendingAssetId: USDT_BASE,
            receivingAssetId: USDC_BASE,
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

interface IPermit2ProxyView {
    function LIFI_DIAMOND() external view returns (address);
}

interface IPermit2Proxy {
    function callDiamondWithPermit2(
        bytes calldata _diamondCalldata,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable returns (bytes memory);
}

interface IDiamondLoupe {
    function facetAddress(
        bytes4 _functionSelector
    ) external view returns (address facetAddress_);
}
