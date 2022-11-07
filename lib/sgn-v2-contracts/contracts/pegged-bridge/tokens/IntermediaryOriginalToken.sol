// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Intermediary token that automatically transfers the canonical token when interacting with approved bridges.
 */
contract IntermediaryOriginalToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    mapping(address => bool) public bridges;
    address public immutable canonical; // canonical token

    event BridgeUpdated(address bridge, bool enable);

    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory bridges_,
        address canonical_
    ) ERC20(name_, symbol_) {
        for (uint256 i = 0; i < bridges_.length; i++) {
            bridges[bridges_[i]] = true;
        }
        canonical = canonical_;
    }

    function transfer(address _to, uint256 _amount) public virtual override returns (bool) {
        bool success = super.transfer(_to, _amount);
        if (bridges[msg.sender]) {
            _burn(_to, _amount);
            IERC20(canonical).safeTransfer(_to, _amount);
        }
        return success;
    }

    function transferFrom(
        address _from,
        address _to,
        uint256 _amount
    ) public virtual override returns (bool) {
        if (bridges[msg.sender]) {
            _mint(_from, _amount);
            IERC20(canonical).safeTransferFrom(_from, address(this), _amount);
        }
        return super.transferFrom(_from, _to, _amount);
    }

    function updateBridge(address _bridge, bool _enable) external onlyOwner {
        bridges[_bridge] = _enable;
        emit BridgeUpdated(_bridge, _enable);
    }

    // to make compatible with BEP20
    function getOwner() external view returns (address) {
        return owner();
    }

    function decimals() public view virtual override returns (uint8) {
        return ERC20(canonical).decimals();
    }
}
