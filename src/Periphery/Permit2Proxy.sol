// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless (Permit2-enabled) calls to our
///         diamond contract
/// @custom:version 1.0.0
contract Permit2Proxy {
    /// Storage ///

    address public immutable LIFI_DIAMOND;
    ISignatureTransfer public immutable PERMIT2;
    mapping(address => bool) public diamondWhitelist;

    string public constant WITNESS_TYPE_STRING =
        "LIFICall witness)LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant WITNESS_TYPEHASH =
        keccak256(
            "LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)"
        );
    bytes32 public immutable PERMIT_WITH_WITNESS_TYPEHASH;

    /// Types ///

    // @dev LIFI Specific Witness to verify
    struct LIFICall {
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
    /// @param diamondCalldata Address of the token to be bridged
    function callDiamondWithEIP2612Signature(
        address tokenAddress,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata diamondCalldata
    ) public payable {
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
        _executeCalldata(diamondCalldata);
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
    ) external payable {
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

        _executeCalldata(_diamondCalldata);
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
    ) external payable {
        LIFICall memory lifiCall = LIFICall(
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

        _executeCalldata(_diamondCalldata);
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
        Permit2Proxy.LIFICall memory lifiCall = LIFICall(
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
        Permit2Proxy.LIFICall memory lifiCall
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

    function _executeCalldata(bytes memory diamondCalldata) internal {
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
    }
}
