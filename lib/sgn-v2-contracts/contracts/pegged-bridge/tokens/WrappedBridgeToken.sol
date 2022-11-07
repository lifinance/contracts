// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// Use pegged model to support no-slippage liquidity pool
contract WrappedBridgeToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    // The PeggedTokenBridge
    address public bridge;
    // The canonical
    address public immutable canonical;

    mapping(address => uint256) public liquidity;

    event BridgeUpdated(address bridge);
    event LiquidityAdded(address provider, uint256 amount);
    event LiquidityRemoved(address provider, uint256 amount);

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
        _mint(address(this), _amount);
        IERC20(canonical).safeTransfer(_to, _amount);
        return true;
    }

    function burn(address _from, uint256 _amount) external onlyBridge returns (bool) {
        _burn(address(this), _amount);
        IERC20(canonical).safeTransferFrom(_from, address(this), _amount);
        return true;
    }

    function addLiquidity(uint256 _amount) external {
        liquidity[msg.sender] += _amount;
        IERC20(canonical).safeTransferFrom(msg.sender, address(this), _amount);
        emit LiquidityAdded(msg.sender, _amount);
    }

    function removeLiquidity(uint256 _amount) external {
        liquidity[msg.sender] -= _amount;
        IERC20(canonical).safeTransfer(msg.sender, _amount);
        emit LiquidityRemoved(msg.sender, _amount);
    }

    function updateBridge(address _bridge) external onlyOwner {
        bridge = _bridge;
        emit BridgeUpdated(bridge);
    }

    function decimals() public view virtual override returns (uint8) {
        return ERC20(canonical).decimals();
    }

    // to make compatible with BEP20
    function getOwner() external view returns (address) {
        return owner();
    }
}
