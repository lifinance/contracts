// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ISignatureTransfer } from "../interfaces/ISignatureTransfer.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { LibAsset, IERC20 } from "lifi/Libraries/LibAsset.sol";
import { console2 } from "forge-std/console2.sol";

interface IPermit2 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @title Permit2Proxy
/// @author LI.FI (https://li.fi)
/// @notice Proxy contract allowing gasless (Permit2-enabled) calls to our diamond contract
/// @custom:version 1.0.0
contract Permit2Proxy is TransferrableOwnership {
    string private constant _WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address tokenReceiver,address diamondAddress,bytes diamondCalldata)";
    bytes32 private constant _WITNESS_TYPEHASH =
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

    /// Events ///
    event WhitelistUpdated(address[] addresses, bool[] values);

    /// Constructor
    constructor(
        address permit2Address,
        address owner
    ) TransferrableOwnership(owner) {
        permit2 = ISignatureTransfer(permit2Address);
    }

    function gaslessWitnessDiamondCallSingleToken(
        ISignatureTransfer.PermitTransferFrom memory permit,
        uint256 amount,
        bytes memory witnessData,
        address senderAddress,
        bytes calldata signature
    ) external {
        // decode witnessData to obtain calldata and diamondAddress
        Witness memory wittness = abi.decode(witnessData, (Witness));

        // transfer inputToken from user to calling wallet using Permit2 signature
        // we send tokenReceiver, diamondAddress and diamondCalldata as Witness to the permit contract to ensure:
        // a) that tokens can only be transferred to the wallet calling this function (as signed by the user)
        // b) that only the diamondAddress can be called which was signed by the user
        // c) that only the diamondCalldata can be executed which was signed by the user
        permit2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails(
                wittness.tokenReceiver,
                amount
            ),
            senderAddress,
            keccak256(witnessData),
            _WITNESS_TYPE_STRING,
            signature
        );

        // maxApprove token to diamond if allowance is insufficient already
        LibAsset.maxApproveERC20(
            IERC20(permit.permitted.token),
            wittness.diamondAddress,
            amount
        );

        _executeCalldata(wittness.diamondAddress, wittness.diamondCalldata);
    }

    function gaslessWitnessDiamondCallMultipleTokens(
        ISignatureTransfer.PermitBatchTransferFrom memory permit,
        uint256 amount,
        address senderAddress,
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
                senderAddress,
                keccak256(
                    abi.encode(
                        _WITNESS_TYPEHASH,
                        Witness(address(this), diamondAddress, diamondCalldata)
                    )
                ), // witness
                _WITNESS_TYPE_STRING,
                signature
            );

            // ensure maxApproval to diamond
            LibAsset.maxApproveERC20(
                IERC20(permit.permitted[i].token),
                diamondAddress,
                amount
            );

            unchecked {
                ++i;
            }
        }

        _executeCalldata(diamondAddress, diamondCalldata);
    }

    function _executeCalldata(
        address diamondAddress,
        bytes memory diamondCalldata
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

    function updateWhitelist(
        address[] calldata addresses,
        bool[] calldata values
    ) external onlyOwner {
        for (uint i; i < addresses.length; ) {
            // update whitelist address value
            diamondWhitelist[addresses[i]] = values[i];

            //increase loop counter (gas-efficiently)
            unchecked {
                ++i;
            }
        }
        emit WhitelistUpdated(addresses, values);
    }
}
