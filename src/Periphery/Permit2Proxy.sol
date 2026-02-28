// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { IERC20Permit7597 } from "lifi/Interfaces/IERC20Permit7597.sol";
import { IERC20TransferWithAuthorization } from "lifi/Interfaces/IERC20TransferWithAuthorization.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { WithdrawablePeriphery } from "lifi/Helpers/WithdrawablePeriphery.sol";

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless calls via Permit2, ERC20 Permit (EIP-2612),
///         and EIP-3009 receiveWithAuthorization to our diamond contract
/// @custom:version 1.1.0
contract Permit2Proxy is WithdrawablePeriphery {
    /// Storage ///

    address public immutable LIFI_DIAMOND;
    ISignatureTransfer public immutable PERMIT2;

    string public constant WITNESS_TYPE_STRING =
        // solhint-disable-next-line max-line-length
        "LiFiCall witness)LiFiCall(address diamondAddress,bytes32 diamondCalldataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant WITNESS_TYPEHASH =
        keccak256(
            "LiFiCall(address diamondAddress,bytes32 diamondCalldataHash)"
        );
    bytes32 public immutable PERMIT_WITH_WITNESS_TYPEHASH;

    /// Types ///

    /// @dev LI.FI-specific witness verifying the intended calldata and diamond address
    struct LiFiCall {
        address diamondAddress;
        bytes32 diamondCalldataHash;
    }

    /// Errors ///

    error CallToDiamondFailed(bytes);

    /// Constructor ///

    constructor(
        address _lifiDiamond,
        ISignatureTransfer _permit2,
        address _owner
    ) WithdrawablePeriphery(_owner) {
        LIFI_DIAMOND = _lifiDiamond;
        PERMIT2 = _permit2;

        PERMIT_WITH_WITNESS_TYPEHASH = keccak256(
            abi.encodePacked(
                PermitHash._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
                WITNESS_TYPE_STRING
            )
        );
    }

    /// External Functions — EIP-2612 ///

    /// @notice Bridges tokens through the LI.FI diamond using an EIP-2612 permit (v, r, s).
    ///         Only works with tokens that implement EIP-2612.
    /// The permit signer must be the caller to prevent front-running and ensure
    /// the calldata cannot be replaced by others.
    /// Can only be called by the permit signer to prevent front-running.
    /// @param tokenAddress Address of the token to be bridged
    /// @param amount Amount of tokens to be bridged
    /// @param deadline Transaction must be completed before this timestamp
    /// @param v User signature (recovery ID)
    /// @param r User signature (ECDSA output)
    /// @param s User signature (ECDSA output)
    /// @param diamondCalldata Calldata to execute on the diamond
    /// @return Return data from the diamond call
    function callDiamondWithEIP2612Signature(
        address tokenAddress,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata diamondCalldata
    ) public payable returns (bytes memory) {
        // call permit on token contract to register approval using signature
        try
            ERC20Permit(tokenAddress).permit(
                msg.sender, // Ensure msg.sender is same wallet that signed permit
                address(this),
                amount,
                deadline,
                v,
                r,
                s
            )
        {} catch Error(string memory reason) {
            if (
                IERC20(tokenAddress).allowance(msg.sender, address(this)) <
                amount
            ) {
                revert(reason);
            }
        } catch (bytes memory reason) {
            if (
                IERC20(tokenAddress).allowance(msg.sender, address(this)) <
                amount
            ) {
                LibUtil.revertWith(reason);
            }
        }

        LibAsset.transferFromERC20(
            tokenAddress,
            msg.sender,
            address(this),
            amount
        );

        return
            _maxApproveAndExecuteCalldata(
                tokenAddress,
                amount,
                diamondCalldata
            );
    }

    /// @notice Bridges tokens using EIP-2612 permit with opaque bytes signature (ERC-7597),
    ///         for smart contract signers (e.g. Coinbase Smart Wallet). Backend supplies signature bytes per wallet format.
    /// @param tokenAddress Address of the token
    /// @param amount Amount to permit and transfer
    /// @param deadline Permit deadline
    /// @param signature Opaque signature bytes (e.g. abi.encode(ownerIndex, abi.encodePacked(r,s,v)) for Coinbase Wallet)
    /// @param diamondCalldata Calldata to execute on the diamond
    /// @return Return data from the diamond call
    function callDiamondWithEIP2612Signature(
        address tokenAddress,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature,
        bytes calldata diamondCalldata
    ) public payable returns (bytes memory) {
        try
            IERC20Permit7597(tokenAddress).permit(
                msg.sender,
                address(this),
                amount,
                deadline,
                signature
            )
        {} catch Error(string memory reason) {
            if (
                IERC20(tokenAddress).allowance(msg.sender, address(this)) <
                amount
            ) {
                revert(reason);
            }
        } catch (bytes memory reason) {
            if (
                IERC20(tokenAddress).allowance(msg.sender, address(this)) <
                amount
            ) {
                LibUtil.revertWith(reason);
            }
        }

        LibAsset.transferFromERC20(
            tokenAddress,
            msg.sender,
            address(this),
            amount
        );

        return
            _maxApproveAndExecuteCalldata(
                tokenAddress,
                amount,
                diamondCalldata
            );
    }

    /// External Functions — EIP-3009 receiveWithAuthorization ///

    /// @notice Bridges tokens using EIP-3009 receiveWithAuthorization (v, r, s).
    ///         Only the payee (this proxy) can execute on the token; front-run safe. Caller must be the signer.
    /// @dev We do not support transferWithAuthorization due to front-run risk; only receiveWithAuthorization is offered.
    /// @param tokenAddress Address of the token to be bridged
    /// @param amount Amount of tokens to be bridged
    /// @param validAfter Authorization valid only after this timestamp
    /// @param validBefore Authorization valid only before this timestamp
    /// @param nonce Unique nonce to prevent replay
    /// @param v User signature (recovery ID)
    /// @param r User signature (ECDSA output)
    /// @param s User signature (ECDSA output)
    /// @param diamondCalldata Calldata to execute on the diamond
    /// @return Return data from the diamond call
    function callDiamondWithEIP3009Signature(
        address tokenAddress,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata diamondCalldata
    ) public payable returns (bytes memory) {
        IERC20TransferWithAuthorization(tokenAddress).receiveWithAuthorization(
            msg.sender,
            address(this),
            amount,
            validAfter,
            validBefore,
            nonce,
            v,
            r,
            s
        );
        return
            _maxApproveAndExecuteCalldata(
                tokenAddress,
                amount,
                diamondCalldata
            );
    }

    /// @notice Bridges tokens using EIP-3009 receiveWithAuthorization with opaque bytes signature (ERC-7598 / ERC-1271).
    /// @param tokenAddress Address of the token to be bridged
    /// @param amount Amount of tokens to be bridged
    /// @param validAfter Authorization valid only after this timestamp
    /// @param validBefore Authorization valid only before this timestamp
    /// @param nonce Unique nonce to prevent replay
    /// @param signature Opaque signature bytes (e.g. wallet-encoded for contract signers)
    /// @param diamondCalldata Calldata to execute on the diamond
    /// @return Return data from the diamond call
    /// @dev Front-run safe; same as the (v,r,s) overload.
    function callDiamondWithEIP3009Signature(
        address tokenAddress,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        bytes calldata diamondCalldata
    ) public payable returns (bytes memory) {
        IERC20TransferWithAuthorization(tokenAddress).receiveWithAuthorization(
            msg.sender,
            address(this),
            amount,
            validAfter,
            validBefore,
            nonce,
            signature
        );
        return
            _maxApproveAndExecuteCalldata(
                tokenAddress,
                amount,
                diamondCalldata
            );
    }

    /// External Functions — Permit2 ///

    /// @notice Bridges tokens using Uniswap Permit2 and a signature that verifies allowance.
    ///         Caller must be the permit signer to prevent front-running.
    /// @param _diamondCalldata the calldata to execute
    /// @param _permit the Uniswap Permit2 parameters
    /// @param _signature Signature granting token transfer approval
    /// @return Return data from the diamond call
    function callDiamondWithPermit2(
        bytes calldata _diamondCalldata,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable returns (bytes memory) {
        PERMIT2.permitTransferFrom(
            _permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: _permit.permitted.amount
            }),
            msg.sender, // Ensure msg.sender is same wallet that signed permit
            _signature
        );
        return
            _maxApproveAndExecuteCalldata(
                _permit.permitted.token,
                _permit.permitted.amount,
                _diamondCalldata
            );
    }

    /// @notice Bridges tokens using Permit2 with witness (diamond address and calldata hash bound to signature).
    /// @param _diamondCalldata Calldata to execute on the diamond
    /// @param _signer Signer granting transfer permission
    /// @param _permit Uniswap Permit2 parameters
    /// @param _signature Signature granting token transfer approval
    /// @return Return data from the diamond call
    function callDiamondWithPermit2Witness(
        bytes calldata _diamondCalldata,
        address _signer,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable returns (bytes memory) {
        LiFiCall memory lifiCall = LiFiCall(
            LIFI_DIAMOND,
            keccak256(_diamondCalldata)
        );

        bytes32 witness = keccak256(abi.encode(WITNESS_TYPEHASH, lifiCall));

        PERMIT2.permitWitnessTransferFrom(
            _permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: _permit.permitted.amount
            }),
            _signer,
            witness,
            WITNESS_TYPE_STRING,
            _signature
        );
        return
            _maxApproveAndExecuteCalldata(
                _permit.permitted.token,
                _permit.permitted.amount,
                _diamondCalldata
            );
    }

    /// External Functions — Permit2 view helpers ///

    /// @notice Returns the EIP-712 message hash for signing a Permit2 witness transfer (for the given calldata and params).
    /// @param _diamondCalldata Calldata that will be executed on the diamond
    /// @param _assetId Token to approve
    /// @param _amount Amount to approve
    /// @param _nonce Nonce for the permit
    /// @param _deadline Permit deadline
    /// @return msgHash Message hash to sign
    function getPermit2MsgHash(
        bytes calldata _diamondCalldata,
        address _assetId,
        uint256 _amount,
        uint256 _nonce,
        uint256 _deadline
    ) external view returns (bytes32 msgHash) {
        // Token Permissions
        ISignatureTransfer.TokenPermissions
            memory tokenPermissions = ISignatureTransfer.TokenPermissions(
                _assetId,
                _amount
            );
        bytes32 tokenPermissionsHash = _getTokenPermissionsHash(
            tokenPermissions
        );

        // Witness
        Permit2Proxy.LiFiCall memory lifiCall = LiFiCall(
            LIFI_DIAMOND,
            keccak256(_diamondCalldata)
        );
        bytes32 witness = _getWitnessHash(lifiCall);

        // PermitTransferWithWitness
        msgHash = _getPermitWitnessTransferFromHash(
            PERMIT2.DOMAIN_SEPARATOR(),
            tokenPermissionsHash,
            address(this),
            _nonce,
            _deadline,
            witness
        );
    }

    /// Internal Functions — Permit2 hash helpers ///

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
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(WITNESS_TYPEHASH, lifiCall));
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

    /// Internal Functions — Execution ///

    function _maxApproveAndExecuteCalldata(
        address tokenAddress,
        uint256 amount,
        bytes calldata diamondCalldata
    ) internal returns (bytes memory) {
        LibAsset.maxApproveERC20(IERC20(tokenAddress), LIFI_DIAMOND, amount);

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = LIFI_DIAMOND.call{
            value: msg.value
        }(diamondCalldata);

        if (!success) {
            revert CallToDiamondFailed(data);
        }
        return data;
    }

    /// Internal Functions — Permit2 nonce utilities (adapted from
    /// https://github.com/flood-protocol/permit2-nonce-finder) ///

    /// @dev Use when signing multiple nonces in a row and you need the next valid nonce.
    ///      but the start one is still valid.
    /// @notice Finds the next valid nonce for a user, starting from 0.
    /// @param owner The owner of the nonces
    /// @return nonce First valid nonce starting from 0
    function nextNonce(address owner) external view returns (uint256 nonce) {
        nonce = _nextNonce(owner, 0, 0);
    }

    /// @notice Finds the next valid nonce for a user, after from a given nonce.
    /// @dev This can be helpful if you're signing multiple nonces in a row and need the next nonce to sign
    ///      but the start one is still valid.
    /// @param owner The owner of the nonces
    /// @param start The nonce to start from
    /// @return nonce First valid nonce after the given nonce
    function nextNonceAfter(
        address owner,
        uint256 start
    ) external view returns (uint256 nonce) {
        uint248 word = uint248(start >> 8);
        uint8 pos = uint8(start);
        if (pos == type(uint8).max) {
            // If the position is 255, we need to move to the next word
            word++;
            pos = 0;
        } else {
            // Otherwise, we just move to the next position
            pos++;
        }
        nonce = _nextNonce(owner, word, pos);
    }

    /// @notice Finds the next valid nonce for a user, starting from a given word and position.
    /// @param owner The owner of the nonces
    /// @param word Word to start looking from
    /// @param pos Position inside the word to start looking from
    function _nextNonce(
        address owner,
        uint248 word,
        uint8 pos
    ) internal view returns (uint256 nonce) {
        while (true) {
            uint256 bitmap = PERMIT2.nonceBitmap(owner, word);

            // Check if the bitmap is completely full
            if (bitmap == type(uint256).max) {
                // If so, move to the next word
                ++word;
                pos = 0;
                continue;
            }
            if (pos != 0) {
                // If the position is not 0, we need to shift the bitmap to ignore the bits before position
                bitmap = bitmap >> pos;
            }
            // Find the first zero bit in the bitmap
            while (bitmap & 1 == 1) {
                bitmap = bitmap >> 1;
                ++pos;
            }

            return _nonceFromWordAndPos(word, pos);
        }
    }

    /// @notice Constructs a nonce from a word and a bit position.
    /// @param word The word containing the nonce
    /// @param pos The position of the nonce inside the word
    /// @return nonce Nonce built from word and position
    function _nonceFromWordAndPos(
        uint248 word,
        uint8 pos
    ) internal pure returns (uint256 nonce) {
        // The last 248 bits of the word are the nonce bits
        nonce = uint256(word) << 8;
        // The first 8 bits of the word are the position inside the word
        nonce |= pos;
    }

    /// Receive native token refunds from the diamond
    receive() external payable {}
}
