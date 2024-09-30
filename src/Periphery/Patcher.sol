// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @title Patcher
/// @author LI.FI (https://li.fi)
/// @notice Patcher for contract call data used for variable input operations
/// @custom:version 1.0.0
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

interface DexManagerFacet {
    function isFunctionApproved(
        bytes4 _signature
    ) external view returns (bool approved);
    function isContractApproved(
        address _contract
    ) external view returns (bool approved);
}


contract Patcher {
    address public immutable diamond;

    struct Override {
        uint256 initialByteOffset;
    }
    struct SwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    error InvalidBytesOp(string);
    error InternalCallFailed();
    error ContractCallNotAllowed();

    constructor(address _diamond) {
        diamond = _diamond;
    }

    function replaceUint256At(
        bytes memory bs,
        uint256 index,
        bytes32 newData
    ) public pure {
        if (bs.length < index + 32)
            revert InvalidBytesOp(
                "Replacement index + 32 bits is out of bounds"
            );
        uint256 writeAt = 32 + index;
        assembly {
            mstore(add(bs, writeAt), newData)
        }
    }

    function patchWithAvailableAmounts(
        uint256[] calldata offsets,
        address inputToken,
        bytes calldata bs
    ) public view returns (bytes memory) {
        bytes memory manipulated = bs;
        uint256 availableBalance = LibAsset.getOwnBalance(inputToken);
        for (uint64 i = 0; i < offsets.length; i++) {
            replaceUint256At(
                manipulated,
                offsets[i],
                bytes32(availableBalance)
            );
        }
        return manipulated;
    }

    function patchWithAvailableAmountsAndForward(
        uint256[] calldata offsets,
        address inputToken,
        address outputToken,
        bytes calldata bs,
        address payable callTo
    ) public returns (bytes memory) {

        DexManagerFacet facet = DexManagerFacet(diamond);
        if (!facet.isFunctionApproved(bytes4(bs[:4]))) { //|| !facet.isContractApproved(callTo)) {
            revert ContractCallNotAllowed();
        }

        if (!LibAsset.isNativeAsset(inputToken)) {
            IERC20 token = IERC20(inputToken);
            uint256 balance = token.balanceOf(address(msg.sender));
            LibAsset.depositAsset(inputToken, balance);
            token.approve(callTo, balance);
        }

        bytes memory patchedCalldata = patchWithAvailableAmounts(
            offsets,
            inputToken,
            bs
        );
        (bool success, bytes memory res) = callTo.call(patchedCalldata);
        if (!success) revert InternalCallFailed();

        LibAsset.transferAsset(
            outputToken,
            payable(address(msg.sender)),
            LibAsset.getOwnBalance(outputToken)
        );

        return res;
    }

    /// @notice Receive native asset directly.
    /// @dev Some bridges may send native asset before execute external calls.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
