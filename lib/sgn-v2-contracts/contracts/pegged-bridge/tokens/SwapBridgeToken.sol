// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ISwapCanoToken {
    function swapBridgeForCanonical(address, uint256) external returns (uint256);

    function swapCanonicalForBridge(address, uint256) external returns (uint256);
}

/**
 * @title Per bridge intermediary token that supports swapping with a canonical token.
 */
contract SwapBridgeToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    address public bridge;
    address public immutable canonical; // canonical token that support swap

    event BridgeUpdated(address bridge);

    modifier onlyBridge() {
        require(msg.sender == bridge, "caller is not bridge");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address bridge_,
        address canonical_
    ) ERC20(name_, symbol_) {
        bridge = bridge_;
        canonical = canonical_;
    }

    function mint(address _to, uint256 _amount) external onlyBridge returns (bool) {
        _mint(address(this), _amount); // add amount to myself so swapBridgeForCanonical can transfer amount
        uint256 got = ISwapCanoToken(canonical).swapBridgeForCanonical(address(this), _amount);
        // now this has canonical token, next step is to transfer to user
        IERC20(canonical).safeTransfer(_to, got);
        return true;
    }

    function burn(address _from, uint256 _amount) external onlyBridge returns (bool) {
        IERC20(canonical).safeTransferFrom(_from, address(this), _amount);
        uint256 got = ISwapCanoToken(canonical).swapCanonicalForBridge(address(this), _amount);
        _burn(address(this), got);
        return true;
    }

    function updateBridge(address _bridge) external onlyOwner {
        bridge = _bridge;
        emit BridgeUpdated(bridge);
    }

    // approve canonical token so swapBridgeForCanonical can work. or we approve before call it in mint w/ added gas
    function approveCanonical() external onlyOwner {
        _approve(address(this), canonical, type(uint256).max);
    }

    function revokeCanonical() external onlyOwner {
        _approve(address(this), canonical, 0);
    }

    // to make compatible with BEP20
    function getOwner() external view returns (address) {
        return owner();
    }

    function decimals() public view virtual override returns (uint8) {
        return ERC20(canonical).decimals();
    }
}
