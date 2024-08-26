// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { PermitHash } from "permit2/libraries/PermitHash.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Permit2Proxy is TransferrableOwnership {
    /// Storage ///

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
    error DiamondAddressNotWhitelisted();

    /// Events ///

    event WhitelistUpdated(address[] addresses, bool[] values);

    /// Constructor ///

    constructor(
        address _owner,
        ISignatureTransfer _permit2
    ) TransferrableOwnership(_owner) {
        PERMIT2 = _permit2;

        PERMIT_WITH_WITNESS_TYPEHASH = keccak256(
            abi.encodePacked(
                PermitHash._PERMIT_TRANSFER_FROM_WITNESS_TYPEHASH_STUB,
                WITNESS_TYPE_STRING
            )
        );
    }

    /// External Functions ///

    /// @notice Forwards a call to a whitelisted LIFI diamond
    ///         pulling tokens from the user using Uniswap Permit2
    /// @param _diamondAddress the diamond contract to execute the call
    /// @param _diamondCalldata the calldata to execute
    /// @param _signer the signer giving permission to transfer tokens
    /// @param _permit the Uniswap Permit2 parameters
    /// @param _signature the signature giving approval to transfer tokens
    function diamondCallSingle(
        address _diamondAddress,
        bytes calldata _diamondCalldata,
        address _signer,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable {
        LIFICall memory lifiCall = LIFICall(
            _diamondAddress,
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
            _diamondAddress,
            _permit.permitted.amount
        );

        _executeCalldata(_diamondAddress, _diamondCalldata);
    }

    /// @notice Allows to update the whitelist of diamond contracts
    /// @dev Admin function
    /// @param addresses Addresses to be added (true) or removed (false) from whitelist
    /// @param values Values for each address that should be updated
    function updateWhitelist(
        address[] calldata addresses,
        bool[] calldata values
    ) external onlyOwner {
        for (uint i; i < addresses.length; ) {
            // update whitelist address value
            diamondWhitelist[addresses[i]] = values[i];

            // gas-efficient way to increase the loop counter
            unchecked {
                ++i;
            }
        }
        emit WhitelistUpdated(addresses, values);
    }

    /// @notice utitlity method for constructing a valid Permit2 message hash
    /// @param _diamondAddress the diamond address to call
    /// @param _diamondCalldata the calldata to execute
    /// @param _assetId the address of the token to approve
    /// @param _amount amount of tokens to approve
    /// @param _nonce the nonce to use
    /// @param _deadline the expiration deadline
    function getPermit2MsgHash(
        address _diamondAddress,
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
            _diamondAddress,
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

    function _executeCalldata(
        address diamondAddress,
        bytes memory diamondCalldata
    ) internal {
        // make sure diamondAddress is whitelisted
        // this limits the usage of this Permit2Proxy contracts to only work with our diamond contracts
        if (!diamondWhitelist[diamondAddress])
            revert DiamondAddressNotWhitelisted();

        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = diamondAddress.call{
            value: msg.value
        }(diamondCalldata);
        // throw error to make sure tx reverts if low-level call was unsuccessful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
    }
}
