// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// import { Permit2 } from "@uniswap/permit2/src/Permit2.sol";
import { Permit2 } from "permit2/src/Permit2.sol";

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless (Permit2-enabled) calls to our diamond contract
/// @custom:version 1.0.0
contract ERC20Proxy is Ownable {
    string private constant WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)";
    bytes32 private constant WITNESS_TYPEHASH =
        keccak256(
            "Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)"
        );

    struct Witness {
        address tokenReceiver;
        address diamondAddress;
        bytes diamondCalldata;
    }

    /// Storage ///
    Permit2 public permit2;
    mapping(address => bool) public diamondWhitelist;

    /// Errors ///
    error DiamondAddressNotWhitelisted();
    error CallToDiamondFailed(bytes data);

    /// Events ///

    /// Constructor
    constructor(address permit2Address) {
        permit2 = Permit2(permit2Address);
    }

    // TODO:
    // - how do we prevent anyone from getting a user signature, then using entirely different calldata to execute after pulling the user's tokens?
    //   >>> understand the Witness stuff

    /// @notice Sets whether or not a specified caller is authorized to call this contract
    /// @param permit contains information about the token permit (see Uniswap's ISignatureTransfer for more details)
    /// @param transferDetails contains information about recipient and amount of the transfer
    /// @param authorized specifies whether the caller is authorized (true/false)
    function gaslessDiamondCallSingle(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature,
        address diamondAddress,
        bytes calldata diamondCalldata
    ) external onlyOwner {
        // transfer tokens from user to calling wallet using Permit2 signature
        permit2.permitTransferFrom(permit, transferDetails, owner, signature);

        // make sure diamondAddress is whitelisted
        if (!diamondWhitelist[diamondAddress])
            revert DiamondAddressNotWhitelisted();

        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes data) = diamondAddress.call(diamondCalldata);
        // forward funds to _to address and emit event, if cBridge refund successful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
    }

    function gaslessWitnessDiamondCallSingle(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature,
        address diamondAddress,
        bytes calldata diamondCalldata
    ) external onlyOwner {
        // transfer tokens from user to calling wallet using Permit2 signature
        permit2.permitWitnessTransferFrom(
            permit,
            transferDetails,
            owner,
            signature
        );

        // we send tokenReceiver, diamondAddress and diamondCalldata as Witness to the permit contract to ensure:
        // a) that tokens can only be transferred to the wallet calling this function (as signed by the user)
        // b) that only the diamondAddress can be called which was signed by the user
        // c) that only the diamondCalldata can be executed which was signed by the user
        PERMIT2.permitWitnessTransferFrom(
            _permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: msg.sender,
                requestedAmount: _amount
            }),
            _owner,
            keccak256(
                abi.encode(
                    WITNESS_TYPEHASH,
                    Witness(msg.sender, diamondAddres, diamondCalldata)
                )
            ), // witness
            WITNESS_TYPE_STRING,
            _signature
        );

        // make sure diamondAddress is whitelisted
        if (!diamondWhitelist[diamondAddress])
            revert DiamondAddressNotWhitelisted();

        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes data) = diamondAddress.call(diamondCalldata);
        // forward funds to _to address and emit event, if cBridge refund successful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
    }
}
