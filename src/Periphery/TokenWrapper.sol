// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

// solhint-disable-next-line no-unused-import
import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { IWrapper } from "../Interfaces/IWrapper.sol";

/// @title TokenWrapper
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for wrapping and unwrapping tokens
/// @custom:version 1.2.0
contract TokenWrapper is WithdrawablePeriphery {
    address public immutable WRAPPED_TOKEN;
    address public immutable CONVERTER;
    bool private immutable USE_CONVERTER;

    /// Errors ///
    error WithdrawFailure();
    error InvalidWrappedToken();
    error InvalidOwner();
    error InvalidConverter();

    /// @notice Creates a new TokenWrapper contract
    /// @param _wrappedToken Address of the wrapped token (e.g., WETH, or token returned by converter)
    /// @param _converter Address of converter contract, or address(0) if wrapping 1:1 without conversion
    /// @param _owner Address that will own this contract and can withdraw stuck tokens
    /// @dev If converter is provided, all wrap/unwrap operations go through it for decimal or other conversions
    // solhint-disable-next-line no-empty-blocks
    constructor(
        address _wrappedToken,
        address _converter,
        address _owner
    ) WithdrawablePeriphery(_owner) {
        if (_wrappedToken == address(0)) revert InvalidWrappedToken();
        if (_owner == address(0)) revert InvalidOwner();

        WRAPPED_TOKEN = _wrappedToken;
        USE_CONVERTER = _converter != address(0);

        if (USE_CONVERTER) {
            if (!_isContract(_converter)) revert InvalidConverter();
            CONVERTER = _converter;
            // Approve converter once for all future withdrawals (gas optimization)
            LibAsset.maxApproveERC20(
                IERC20(_wrappedToken),
                _converter,
                type(uint256).max
            );
        } else {
            CONVERTER = _wrappedToken;
        }
    }

    /// @dev Check if an address is a contract
    function _isContract(address _addr) private view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(_addr)
        }
        return size > 0;
    }

    /// External Methods ///

    /// @notice Wraps the native token and transfers wrapped tokens to caller
    /// @dev If converter is set, uses it to convert native to wrapped tokens and measures actual amount received
    /// @dev If no converter, wraps native 1:1 and transfers msg.value of wrapped tokens
    function deposit() external payable {
        if (USE_CONVERTER) {
            uint256 balanceBefore = IERC20(WRAPPED_TOKEN).balanceOf(
                address(this)
            );
            IWrapper(CONVERTER).deposit{ value: msg.value }();
            uint256 balanceAfter = IERC20(WRAPPED_TOKEN).balanceOf(
                address(this)
            );
            uint256 amountReceived = balanceAfter - balanceBefore;
            SafeTransferLib.safeTransfer(
                WRAPPED_TOKEN,
                msg.sender,
                amountReceived
            );
        } else {
            IWrapper(CONVERTER).deposit{ value: msg.value }();
            SafeTransferLib.safeTransfer(WRAPPED_TOKEN, msg.sender, msg.value);
        }
    }

    /// @notice Unwraps all the caller's balance of wrapped token and returns native tokens
    /// @dev Pulls wrapped tokens from msg.sender based on their balance (requires prior approval)
    /// @dev If converter is set, measures actual native amount received after conversion
    /// @dev If no converter, unwraps 1:1 and transfers exact amount of native tokens
    function withdraw() external {
        // While in a general purpose contract it would make sense
        // to have `amount` equal to the minimum between the balance and the
        // given allowance, in our specific usecase allowance is always
        // nearly MAX_UINT256. Using the balance only is a gas optimisation.
        uint256 amount = IERC20(WRAPPED_TOKEN).balanceOf(msg.sender);
        SafeTransferLib.safeTransferFrom(
            WRAPPED_TOKEN,
            msg.sender,
            address(this),
            amount
        );

        if (USE_CONVERTER) {
            uint256 balanceBefore = address(this).balance;
            IWrapper(CONVERTER).withdraw(amount);
            uint256 balanceAfter = address(this).balance;
            uint256 amountReceived = balanceAfter - balanceBefore;
            SafeTransferLib.safeTransferETH(msg.sender, amountReceived);
        } else {
            IWrapper(CONVERTER).withdraw(amount);
            SafeTransferLib.safeTransferETH(msg.sender, amount);
        }
    }

    // Needs to be able to receive native on `withdraw`
    receive() external payable {}
}
