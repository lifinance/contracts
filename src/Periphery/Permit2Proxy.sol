// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ISignatureTransfer } from "permit2/interfaces/ISignatureTransfer.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Permit2Proxy {
    /// Storage ///

    ISignatureTransfer public immutable PERMIT2;

    string public constant WITNESS_TYPE_STRING =
        "LIFICall witness)LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)TokenPermissions(address token,uint256 amount)";
    bytes32 public constant WITNESS_TYPEHASH =
        keccak256(
            "LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)"
        );

    /// Types ///

    // @dev LIFI Specific Witness to verify
    struct LIFICall {
        address tokenReceiver;
        address diamondAddress;
        bytes32 diamondCalldataHash;
    }

    /// Errors ///

    error CallToDiamondFailed(bytes);

    /// Constructor ///

    constructor(ISignatureTransfer _permit2) {
        PERMIT2 = _permit2;
    }

    /// External Functions ///

    function maxApproveERC20(
        IERC20 assetId,
        address spender,
        uint256 amount
    ) internal {
        if (address(assetId) == address(0)) {
            return;
        }

        if (assetId.allowance(address(this), spender) < amount) {
            SafeERC20.safeIncreaseAllowance(IERC20(assetId), spender, 0);
            SafeERC20.safeIncreaseAllowance(
                IERC20(assetId),
                spender,
                type(uint).max
            );
        }
    }

    function diamondCallSingle(
        address _tokenReceiver,
        address _diamondAddress,
        bytes calldata _diamondCalldata,
        address _owner,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable {
        LIFICall memory lifiCall = LIFICall(
            _tokenReceiver,
            _diamondAddress,
            keccak256(_diamondCalldata)
        );

        bytes32 witness = keccak256(
            abi.encode(
                WITNESS_TYPEHASH,
                lifiCall.tokenReceiver,
                lifiCall.diamondAddress,
                lifiCall.diamondCalldataHash
            )
        );

        PERMIT2.permitWitnessTransferFrom(
            _permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: _permit.permitted.amount
            }),
            _owner,
            witness,
            WITNESS_TYPE_STRING,
            _signature
        );

        maxApproveERC20(
            IERC20(_permit.permitted.token),
            _diamondAddress,
            _permit.permitted.amount
        );

        // call diamond with provided calldata
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory data) = _diamondAddress.call{
            value: msg.value
        }(_diamondCalldata);
        // throw error to make sure tx reverts if low-level call was unsuccessful
        if (!success) {
            revert CallToDiamondFailed(data);
        }
    }
}
