// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IOntologyBridgeTokenWrapper {
    function swapBridgeForCanonical(
        address bridgeToken,
        address _to,
        uint256 _amount
    ) external returns (uint256);

    function swapCanonicalForBridge(
        address bridgeToken,
        address _to,
        uint256 _amount
    ) external payable returns (uint256);
}

/**
 * @title Intermediary bridge token that supports swapping with the Ontology bridge token wrapper.
 * NOTE: The bridge wrapper is NOT the canonical token itself.
 */
contract OntologyBridgeToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    // The PeggedTokenBridge
    address public bridge;
    // Bridge token wrapper for swapping
    address public immutable wrapper;
    // The canonical token
    address public immutable canonical;

    event BridgeUpdated(address bridge);

    modifier onlyBridge() {
        require(msg.sender == bridge, "caller is not bridge");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address bridge_,
        address wrapper_,
        address canonical_
    ) ERC20(name_, symbol_) {
        bridge = bridge_;
        wrapper = wrapper_;
        canonical = canonical_;
    }

    function mint(address _to, uint256 _amount) external onlyBridge returns (bool) {
        _mint(address(this), _amount);
        _approve(address(this), wrapper, _amount);
        // NOTE: swapBridgeForCanonical automatically transfers canonical token to _to.
        IOntologyBridgeTokenWrapper(wrapper).swapBridgeForCanonical(address(this), _to, _amount);
        return true;
    }

    function burn(address _from, uint256 _amount) external onlyBridge returns (bool) {
        IERC20(canonical).safeTransferFrom(_from, address(this), _amount);
        IERC20(canonical).safeIncreaseAllowance(address(wrapper), _amount);
        // NOTE: swapCanonicalForBridge automatically transfers bridge token to _from.
        uint256 got = IOntologyBridgeTokenWrapper(wrapper).swapCanonicalForBridge(address(this), _from, _amount);
        _burn(_from, got);
        return true;
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
