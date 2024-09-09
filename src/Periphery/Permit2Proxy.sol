// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless calls via Permit2 as well as making
///         token approvals via ERC20 Permit (EIP-2612) to our diamond contract
/// @custom:version 1.0.0
contract Permit2Proxy {
    /// Storage ///

    address public immutable LIFI_DIAMOND;
    ISignatureTransfer public immutable PERMIT2;

    string public constant WITNESS_TYPE_STRING =
        "LiFiCall witness)LiFiCall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant WITNESS_TYPEHASH =
        keccak256(
            "LiFiCall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)"
        );
    bytes32 public immutable PERMIT_WITH_WITNESS_TYPEHASH;

    /// Types ///

    // @dev LIFI Specific Witness which verifies the correct calldata and
    //      diamond address
    struct LiFiCall {
        address diamondAddress;
        bytes32 diamondCalldataHash;
    }

    /// Errors ///

    error CallToDiamondFailed(bytes);

    /// Constructor ///

    constructor(address _lifiDiamond, ISignatureTransfer _permit2) {
        LIFI_DIAMOND = _lifiDiamond;
        PERMIT2 = _permit2;

        PERMIT_WITH_WITNESS_TYPEHASH = keccak256(
            abi.encodePacked(
                PermitHash._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
                WITNESS_TYPE_STRING
            )
        );
    }

    /// External Functions ///

    /// @notice Allows to bridge tokens through a LI.FI diamond contract using
    /// an EIP2612 gasless permit (only works with tokenAddresses that
    /// implement EIP2612) (in contrast to Permit2, calldata and diamondAddress
    /// are not signed by the user and could therefore be replaced by the user)
    /// Can only be called by the permit signer to prevent front-running.
    /// @param tokenAddress Address of the token to be bridged
    /// @param amount Amount of tokens to be bridged
    /// @param deadline Transaction must be completed before this timestamp
    /// @param v User signature (recovery ID)
    /// @param r User signature (ECDSA output)
    /// @param s User signature (ECDSA output)
    /// @param diamondCalldata calldata to execute
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
        ERC20Permit(tokenAddress).permit(
            msg.sender, // Ensure msg.sender is same wallet that signed permit
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        );

        // deposit assets
        LibAsset.transferFromERC20(
            tokenAddress,
            msg.sender,
            address(this),
            amount
        );

        // maxApprove token to diamond if current allowance is insufficient
        LibAsset.maxApproveERC20(IERC20(tokenAddress), LIFI_DIAMOND, amount);

        // call our diamond to execute calldata
        return _executeCalldata(diamondCalldata);
    }

    /// @notice Allows to bridge tokens of one type through a LI.FI diamond
    ///         contract using Uniswap's Permit2 contract and a user signature
    ///         that verifies allowance. The calldata can be changed by the
    ///         user. Can only be called by the permit signer to prevent
    ///         front-running.
    /// @param _diamondCalldata the calldata to execute
    /// @param _permit the Uniswap Permit2 parameters
    /// @param _signature the signature giving approval to transfer tokens
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

        // maxApprove token to diamond if current allowance is insufficient
        LibAsset.maxApproveERC20(
            IERC20(_permit.permitted.token),
            LIFI_DIAMOND,
            _permit.permitted.amount
        );

        return _executeCalldata(_diamondCalldata);
    }

    /// @notice Allows to bridge tokens of one type through a LI.FI diamond
    ///         contract using Uniswap's Permit2 contract and a user signature
    ///         that verifies allowance, diamondAddress and diamondCalldata
    /// @param _diamondCalldata the calldata to execute
    /// @param _signer the signer giving permission to transfer tokens
    /// @param _permit the Uniswap Permit2 parameters
    /// @param _signature the signature giving approval to transfer tokens
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

        // maxApprove token to diamond if current allowance is insufficient
        LibAsset.maxApproveERC20(
            IERC20(_permit.permitted.token),
            LIFI_DIAMOND,
            _permit.permitted.amount
        );

        return _executeCalldata(_diamondCalldata);
    }

    /// @notice utitlity method for constructing a valid Permit2 message hash
    /// @param _diamondCalldata the calldata to execute
    /// @param _assetId the address of the token to approve
    /// @param _amount amount of tokens to approve
    /// @param _nonce the nonce to use
    /// @param _deadline the expiration deadline
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
        bytes32 permit = _getTokenPermissionsHash(tokenPermissions);

        // Witness
        Permit2Proxy.LiFiCall memory lifiCall = LiFiCall(
            LIFI_DIAMOND,
            keccak256(_diamondCalldata)
        );
        bytes32 witness = _getWitnessHash(lifiCall);

        // PermitTransferWithWitness
        msgHash = _getPermitWitnessTransferFromHash(
            PERMIT2.DOMAIN_SEPARATOR(),
            permit,
            address(this),
            _nonce,
            _deadline,
            witness
        );
    }

    /// Internal Functions ///

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

    function _executeCalldata(
        bytes memory diamondCalldata
    ) internal returns (bytes memory) {
        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = LIFI_DIAMOND.call{
            value: msg.value
        }(diamondCalldata);
        // throw error to make sure tx reverts if low-level call was
        // unsuccessful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
        return data;
    }

    /// The following code was adapted from https://github.com/flood-protocol/permit2-nonce-finder/blob/7a4ac8a58d0b499308000b75ddb2384834f31fac/src/Permit2NonceFinder.sol
    /// Provides utility functions for determining the next valid Permit2 nonce

    /// @notice Finds the next valid nonce for a user, starting from 0.
    /// @param owner The owner of the nonces
    /// @return nonce The first valid nonce starting from 0
    function nextNonce(address owner) external view returns (uint256 nonce) {
        nonce = _nextNonce(owner, 0, 0);
    }

    /// @notice Finds the next valid nonce for a user, after from a given nonce.
    /// @dev This can be helpful if you're signing multiple nonces in a row and need the next nonce to sign but the start one is still valid.
    /// @param owner The owner of the nonces
    /// @param start The nonce to start from
    /// @return nonce The first valid nonce after the given nonce
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

    /// @notice Constructs a nonce from a word and a position inside the word
    /// @param word The word containing the nonce
    /// @param pos The position of the nonce inside the word
    /// @return nonce The nonce constructed from the word and position
    function _nonceFromWordAndPos(
        uint248 word,
        uint8 pos
    ) internal pure returns (uint256 nonce) {
        // The last 248 bits of the word are the nonce bits
        nonce = uint256(word) << 8;
        // The first 8 bits of the word are the position inside the word
        nonce |= pos;
    }
}
