// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @title Forwarder
/// @author LI.FI (https://li.fi)
/// @notice Deposit contract used as entry point for variable swap flows
/// @custom:version 1.0.0
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";

contract Forwarder {
    error InvalidAmount();
    error InsufficientBalance(uint256 want, uint256 got);

    address public immutable _diamond;
    uint256 internal immutable MAX_UINT256 = 2 ** 256 - 1;

    constructor(address diamond) {
        _diamond = diamond;
    }

    function forwardAndBubble(bytes calldata bs) internal {
        (bool success, bytes memory result) = _diamond.call{
            value: msg.value
        }(bs);
        if (!success) {
            if (result.length == 0) revert();
            assembly {
                revert(add(32, result), mload(result))
            }
        }
    }

    function withDiamondDeposit(
        address inputToken,
        bytes calldata bs
    ) public payable {
        deposit(inputToken, _diamond);
        forwardAndBubble(bs);
    }

    function withForwarderDeposit(
        address inputToken,
        bytes calldata bs
    ) public payable {
        deposit(inputToken, address(this));
        LibAsset.maxApproveERC20(IERC20(inputToken), _diamond, MAX_UINT256);
        forwardAndBubble(bs);
    }

    function deposit(address inputToken, address to) internal {
        if (!LibAsset.isNativeAsset(inputToken)) {
            uint256 balance = IERC20(inputToken).balanceOf(msg.sender);
            LibAsset.transferFromERC20(inputToken, msg.sender, to, balance);
        }
    }

    /// @notice Receive native asset directly.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
