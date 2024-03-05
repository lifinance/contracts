// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.17;

import { LibAsset } from "../Libraries/LibAsset.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// External wrapper interface
interface IWrapper {
    function deposit() external payable;
    function withdraw(uint wad) external;
}

/// @title TokenWrapper
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for wrapping and unwrapping tokens
/// @custom:version 1.0.0
contract TokenWrapper is TransferrableOwnership, IWrapper {
    uint256 private constant MAX_INT = 2**256 - 1;
    address public wrappedToken;

    /// Errors ///
    error WithdrawFailure();

    /// Events ///
    event Wrapped(uint256 amount);
    event Unwrapped(uint256 amount);

    IWrapper public externalWrapper;

    /// Constructor ///
    // solhint-disable-next-line no-empty-blocks
    constructor(address _owner, address _wrappedToken) TransferrableOwnership(_owner) {
        wrappedToken = _wrappedToken;
        IERC20(wrappedToken).approve(address(this), MAX_INT);
    }

    /// External Methods ///

    /// @notice Wraps the native token
    function deposit(
    ) external payable {
        IWrapper(wrappedToken).deposit{value: msg.value}();
        IERC20(wrappedToken).transfer(msg.sender, msg.value);
        emit Wrapped(msg.value);
    }

    /// @notice Unwraps the wrapped token
    /// @param wad The amount of token to unwrap
    function withdraw(uint256 wad) external {
        IWrapper(wrappedToken).withdraw(wad);
        (bool success, ) = payable(msg.sender).call{value: wad}("");
        if (!success) {
            revert WithdrawFailure();
        }
        emit Unwrapped(wad);
    }

}

