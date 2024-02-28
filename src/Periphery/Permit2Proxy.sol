// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IPermit2 } from "lifi/Interfaces/IPermit2.sol";
import { TransferrableOwnership } from "lifi/Helpers/TransferrableOwnership.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

//TODO: remove
import { console2 } from "forge-std/console2.sol";

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless (Permit2-enabled) calls to our diamond contract
/// @custom:version 1.0.0
contract Permit2Proxy is TransferrableOwnership {
    using SafeERC20 for IERC20;
    string private constant _WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)";
    bytes32 private constant _WITNESS_TYPEHASH =
        keccak256(
            "Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)"
        );

    /// additional data signed by the user to make sure that their signature can only be used for a specific call
    struct Witness {
        address tokenReceiver;
        address diamondAddress;
        bytes diamondCalldata;
    }

    /// Storage ///
    IPermit2 public permit2;
    mapping(address => bool) public diamondWhitelist;

    /// Errors ///
    error DiamondAddressNotWhitelisted();
    error CallToDiamondFailed(bytes data);

    /// Events ///
    event WhitelistUpdated(address[] addresses, bool[] values);

    /// Constructor
    constructor(
        address permit2Address,
        address owner
    ) TransferrableOwnership(owner) {
        permit2 = IPermit2(permit2Address);
    }

    /// @notice Allows to bridge tokens through a LI.FI diamond contract using an EIP2612 gasless permit
    ///         (only works with tokenAddresses that implement EIP2612)
    ///         (in contrast to Permit2, calldata and diamondAddress are not signed by the user and could therefore be replaced)
    /// @param tokenAddress Address of the token to be bridged
    /// @param owner Owner of the tokens to be bridged
    /// @param amount Amount of tokens to be bridged
    /// @param deadline Transaction must be completed before this timestamp
    /// @param v User signature (recovery ID)
    /// @param r User signature (ECDSA output)
    /// @param s User signature (ECDSA output)
    /// @param diamondAddress Address of the token to be bridged
    /// @param diamondCalldata Address of the token to be bridged
    function callDiamondWithEIP2612Signature(
        address tokenAddress,
        address owner,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        address diamondAddress,
        bytes calldata diamondCalldata
    ) public payable {
        // call permit function of token contract to register approval using signature
        ERC20Permit(tokenAddress).permit(
            owner,
            address(this),
            amount,
            deadline,
            v,
            r,
            s
        );

        // deposit assets
        IERC20(tokenAddress).safeTransferFrom(owner, address(this), amount);

        // maxApprove token to diamond if current allowance is insufficient
        LibAsset.maxApproveERC20(IERC20(tokenAddress), diamondAddress, amount);

        // call our diamond to execute calldata
        _executeCalldata(diamondAddress, diamondCalldata);
    }

    /// @notice Allows to bridge tokens of one type through a LI.FI diamond contract using Uniswap's Permit2 contract
    ///         and a user signature that verifies allowance, diamondAddress and diamondCalldata
    /// @param permit Details of the user-signed permit (that allows to transfer tokens)
    /// @param amount Amount of tokens to be bridged
    /// @param witnessData Encoded data that contains the witness information (= tokenReceiver, diamondAddress, diamondCalldata)
    /// @param owner Address of the token owner
    /// @param signature User signature of permit and witness data
    function callDiamondWithPermit2SignatureSingle(
        IPermit2.PermitTransferFrom memory permit,
        uint256 amount,
        bytes memory witnessData,
        address owner,
        bytes calldata signature
    ) external payable {
        // decode witnessData to obtain calldata and diamondAddress
        Witness memory witness = abi.decode(witnessData, (Witness));

        // transfer inputToken from user to this contract (aka the tokenReceiver) using Permit2 signature
        // we send tokenReceiver, diamondAddress and diamondCalldata as Witness to the permit contract to ensure:
        // a) that tokens can only be transferred to the tokenReceiver address which was signed by the user
        // b) that only the diamondAddress can be called which was signed by the user
        // c) that only the diamondCalldata can be executed which was signed by the user
        permit2.permitWitnessTransferFrom(
            permit,
            IPermit2.SignatureTransferDetails(witness.tokenReceiver, amount),
            owner,
            keccak256(witnessData),
            _WITNESS_TYPE_STRING,
            signature
        );

        // maxApprove token to diamond if current allowance is insufficient
        LibAsset.maxApproveERC20(
            IERC20(permit.permitted.token),
            witness.diamondAddress,
            amount
        );

        // call our diamond to execute calldata
        _executeCalldata(witness.diamondAddress, witness.diamondCalldata);
    }

    /// @notice Allows to bridge multiple tokens at once through a LI.FI diamond contract using Uniswap's Permit2 contract
    ///         and a user signature that verifies allowance, diamondAddress and diamondCalldata
    /// @param permit Details of the user-signed permit (that allows to transfer tokens)
    /// @param amounts Amounts of tokens to be bridged
    /// @param witnessData Encoded data that contains the witness information (= tokenReceiver, diamondAddress, diamondCalldata)
    /// @param owner Address of the token owner
    /// @param signature User signature of permit and witness data
    function callDiamondWithPermit2SignatureBatch(
        IPermit2.PermitBatchTransferFrom memory permit,
        uint256[] calldata amounts,
        bytes memory witnessData,
        address owner,
        bytes calldata signature
    ) external payable {
        // decode witnessData to obtain calldata and diamondAddress
        Witness memory witness = abi.decode(witnessData, (Witness));

        // transfer multiple inputTokens from user to calling wallet using Permit2 signature
        // we send tokenReceiver, diamondAddress and diamondCalldata as Witness to the permit contract to ensure:
        // a) that tokens can only be transferred to the wallet calling this function (as signed by the user)
        // b) that only the diamondAddress can be called which was signed by the user
        // c) that only the diamondCalldata can be executed which was signed by the user
        IPermit2.SignatureTransferDetails[]
            memory transferDetails = new IPermit2.SignatureTransferDetails[](
                amounts.length
            );
        for (uint i; i < amounts.length; ) {
            transferDetails[i] = IPermit2.SignatureTransferDetails(
                address(this),
                amounts[i]
            );

            // ensure maxApproval to diamond
            LibAsset.maxApproveERC20(
                IERC20(permit.permitted[i].token),
                witness.diamondAddress,
                amounts[i]
            );

            // gas-efficient way to increase the loop counter
            unchecked {
                ++i;
            }
        }

        // call Permit2 contract and transfer all tokens
        permit2.permitWitnessTransferFrom(
            permit,
            transferDetails,
            owner,
            keccak256(witnessData),
            _WITNESS_TYPE_STRING,
            signature
        );

        // call our diamond to execute calldata
        _executeCalldata(witness.diamondAddress, witness.diamondCalldata);
    }

    function _executeCalldata(
        address diamondAddress,
        bytes memory diamondCalldata
    ) private {
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
}
