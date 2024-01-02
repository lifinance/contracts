// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ISignatureTransfer } from "../interfaces/ISignatureTransfer.sol";

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless (Permit2-enabled) calls to our diamond contract
/// @custom:version 1.0.0
contract ERC20Proxy {
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
    ISignatureTransfer public permit2;
    mapping(address => bool) public diamondWhitelist;

    /// Errors ///
    error DiamondAddressNotWhitelisted();
    error CallToDiamondFailed(bytes data);

    /// Constructor
    constructor(address permit2Address) {
        permit2 = ISignatureTransfer(permit2Address);
    }

    function gaslessWitnessDiamondCallSingleToken(
        ISignatureTransfer.PermitTransferFrom memory permit,
        uint256 amount,
        address user,
        bytes calldata signature,
        address diamondAddress,
        bytes calldata diamondCalldata
    ) external {
        // transfer inputToken from user to calling wallet using Permit2 signature
        // we send tokenReceiver, diamondAddress and diamondCalldata as Witness to the permit contract to ensure:
        // a) that tokens can only be transferred to the wallet calling this function (as signed by the user)
        // b) that only the diamondAddress can be called which was signed by the user
        // c) that only the diamondCalldata can be executed which was signed by the user
        permit2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails(address(this), amount),
            user,
            keccak256(
                abi.encode(
                    WITNESS_TYPEHASH,
                    Witness(address(this), diamondAddress, diamondCalldata)
                )
            ), // witness
            WITNESS_TYPE_STRING,
            signature
        );

        _executeCalldata((diamondAddress), diamondCalldata);
    }

    function gaslessWitnessDiamondCallMultipleTokens(
        ISignatureTransfer.PermitBatchTransferFrom memory permit,
        uint256 amount,
        address user,
        bytes calldata signature,
        address diamondAddress,
        bytes calldata diamondCalldata
    ) external {
        // transfer multiple inputTokens from user to calling wallet using Permit2 signature
        // we send tokenReceiver, diamondAddress and diamondCalldata as Witness to the permit contract to ensure:
        // a) that tokens can only be transferred to the wallet calling this function (as signed by the user)
        // b) that only the diamondAddress can be called which was signed by the user
        // c) that only the diamondCalldata can be executed which was signed by the user
        for (uint i = 0; i < permit.permitted.length; ) {
            permit2.permitWitnessTransferFrom(
                ISignatureTransfer.PermitTransferFrom(
                    permit.permitted[i],
                    permit.nonce,
                    permit.deadline
                ),
                ISignatureTransfer.SignatureTransferDetails(
                    address(this),
                    amount
                ),
                user,
                keccak256(
                    abi.encode(
                        WITNESS_TYPEHASH,
                        Witness(address(this), diamondAddress, diamondCalldata)
                    )
                ), // witness
                WITNESS_TYPE_STRING,
                signature
            );

            ++i;
        }

        _executeCalldata((diamondAddress), diamondCalldata);
    }

    function _executeCalldata(
        address diamondAddress,
        bytes calldata diamondCalldata
    ) private {
        // a small portion of the tokens will be kept in the wallet (covering the gas cost for this transaction)
        // the rest will be spent to execute the action/calldata signed by the user

        // OPTIONAL STEP
        // swap tokens immediately to nativeToken (to avoid losses due to negative price developments - can be skipped for stablecoins) - User pays gas fee for (potential) swap
        // uniswap.swapExactTokensForETH(...)
        // Alternatively we can also just monitor the ExecutorWallet and swap when tokens reach a certain threshold (but then we pay the gas fee for that)

        // make sure diamondAddress is whitelisted
        // this limits the usage of this Permit2Proxy contracts to only work with our diamond contracts
        if (!diamondWhitelist[diamondAddress])
            revert DiamondAddressNotWhitelisted();

        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = diamondAddress.call(
            diamondCalldata
        );
        // throw error to make sure tx reverts if low-level call was unsuccessful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
    }
}
