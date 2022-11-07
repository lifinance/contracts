// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./MultiBridgeToken.sol";

/**
 * @title Canonical token that supports multi-bridge minter and multi-token swap
 */
contract MintSwapCanonicalToken is MultiBridgeToken {
    using SafeERC20 for IERC20;

    // bridge token address -> minted amount and cap for each bridge
    mapping(address => Supply) public swapSupplies;

    event TokenSwapCapUpdated(address token, uint256 cap);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) MultiBridgeToken(name_, symbol_, decimals_) {}

    /**
     * @notice msg.sender has bridge token and wants to get canonical token.
     * @param _bridgeToken The intermediary token address for a particular bridge.
     * @param _amount The amount.
     */
    function swapBridgeForCanonical(address _bridgeToken, uint256 _amount) external returns (uint256) {
        Supply storage supply = swapSupplies[_bridgeToken];
        require(supply.cap > 0, "invalid bridge token");
        require(supply.total + _amount <= supply.cap, "exceed swap cap");

        supply.total += _amount;
        _mint(msg.sender, _amount);

        // move bridge token from msg.sender to canonical token _amount
        IERC20(_bridgeToken).safeTransferFrom(msg.sender, address(this), _amount);
        return _amount;
    }

    /**
     * @notice msg.sender has canonical token and wants to get bridge token (eg. for cross chain burn).
     * @param _bridgeToken The intermediary token address for a particular bridge.
     * @param _amount The amount.
     */
    function swapCanonicalForBridge(address _bridgeToken, uint256 _amount) external returns (uint256) {
        Supply storage supply = swapSupplies[_bridgeToken];
        require(supply.cap > 0, "invalid bridge token");

        supply.total -= _amount;
        _burn(msg.sender, _amount);

        IERC20(_bridgeToken).safeTransfer(msg.sender, _amount);
        return _amount;
    }

    /**
     * @dev Update existing bridge token swap cap or add a new bridge token with swap cap.
     * Setting cap to 0 will disable the bridge token.
     * @param _bridgeToken The intermediary token address for a particular bridge.
     * @param _swapCap The new swap cap.
     */
    function setBridgeTokenSwapCap(address _bridgeToken, uint256 _swapCap) external onlyOwner {
        swapSupplies[_bridgeToken].cap = _swapCap;
        emit TokenSwapCapUpdated(_bridgeToken, _swapCap);
    }
}
