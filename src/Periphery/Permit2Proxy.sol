// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { ISignatureTransfer } from "../Interfaces/ISignatureTransfer.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Permit2Proxy {
    ISignatureTransfer immutable PERMIT2 =
        ISignatureTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    error CallToDiamondFailed(bytes);

    // LIFI Specific Witness to verify
    struct LIFICall {
        address tokenReceiver;
        address diamondAddress;
        bytes32 diamondCalldataHash;
    }

    string private constant WITNESS_TYPE_STRING =
        "LIFICall witness)TokenPermissions(address token,uint256 amount)LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)";
    bytes32 private WITNESS_TYPEHASH =
        keccak256(
            "LIFICall(address tokenReceiver,address diamondAddress,bytes32 diamondCalldataHash)"
        );

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
        bytes32 _diamondCalldataHash,
        bytes calldata _diamondCalldata,
        address _owner,
        ISignatureTransfer.PermitTransferFrom calldata _permit,
        bytes calldata _signature
    ) external payable {
        bytes32 witnessHash = keccak256(
            abi.encode(
                WITNESS_TYPEHASH,
                LIFICall(_tokenReceiver, _diamondAddress, _diamondCalldataHash)
            )
        );

        PERMIT2.permitWitnessTransferFrom(
            _permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: _permit.permitted.amount
            }),
            _owner,
            witnessHash,
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
