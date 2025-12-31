// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

// solhint-disable-next-line no-unused-import
import { LibAsset } from "../Libraries/LibAsset.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { WithdrawablePeriphery } from "../Helpers/WithdrawablePeriphery.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { WETH } from "solady/tokens/WETH.sol";
import { InvalidContract, InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title TokenWrapper
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for wrapping and unwrapping tokens
/// @dev IMPORTANT: This contract assumes the native token has 18 decimals (standard for all EVM chains)
/// @dev IMPORTANT: The converter contract (if used) MUST NOT charge any fees and should only perform decimal conversion
/// @custom:version 1.2.1
contract TokenWrapper is WithdrawablePeriphery {
    address public immutable WRAPPED_TOKEN;
    address public immutable CONVERTER;
    bool private immutable USE_CONVERTER;
    uint256 private immutable SWAP_RATIO_MULTIPLIER;
    uint256 private constant BASE_DENOMINATOR = 1 ether;

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
        if (_wrappedToken == address(0)) revert InvalidConfig();
        if (_owner == address(0)) revert InvalidConfig();
        if (!LibAsset.isContract(_wrappedToken)) revert InvalidContract();

        WRAPPED_TOKEN = _wrappedToken;
        bool useConverter = _converter != address(0);
        USE_CONVERTER = useConverter;

        if (useConverter) {
            if (!LibAsset.isContract(_converter)) revert InvalidContract();
            // Approve converter once for all future withdrawals (gas optimization)
            LibAsset.maxApproveERC20(
                IERC20(_wrappedToken),
                _converter,
                type(uint256).max
            );
        }

        // Immutable variables must be assigned unconditionally (not inside if statements)
        CONVERTER = useConverter ? _converter : _wrappedToken;
        SWAP_RATIO_MULTIPLIER = useConverter
            ? 10 ** IERC20Metadata(_wrappedToken).decimals()
            : BASE_DENOMINATOR; // 1:1 ratio for 18 decimals
    }

    /// External Methods ///

    /// @notice Wraps the native token and transfers wrapped tokens to caller
    /// @dev If converter is set, uses it to convert native to wrapped tokens using precalculated ratio
    /// @dev If no converter, wraps native 1:1 and transfers msg.value of wrapped tokens
    function deposit() external payable {
        uint256 amount = msg.value;
        WETH(payable(CONVERTER)).deposit{ value: amount }();

        if (USE_CONVERTER) {
            amount = (amount * SWAP_RATIO_MULTIPLIER) / BASE_DENOMINATOR;
        }

        SafeTransferLib.safeTransfer(WRAPPED_TOKEN, msg.sender, amount);
    }

    /// @notice Unwraps all the caller's balance of wrapped token and returns native tokens
    /// @dev Pulls wrapped tokens from msg.sender based on their balance (requires prior approval)
    /// @dev Uses precalculated ratio to determine native token amount to return
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

        WETH(payable(CONVERTER)).withdraw(amount);

        if (USE_CONVERTER) {
            amount = (amount * BASE_DENOMINATOR) / SWAP_RATIO_MULTIPLIER;
        }

        SafeTransferLib.safeTransferETH(msg.sender, amount);
    }

    // Needs to be able to receive native on `withdraw`
    receive() external payable {}
}
