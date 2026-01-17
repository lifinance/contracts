// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IRelayDepository } from "lifi/Interfaces/IRelayDepository.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";

/// @notice Mock Relay Depository contract for testing
/// @dev Implements IRelayDepository interface to allow testing swap+bridge flows
contract MockRelayDepository is IRelayDepository {
    mapping(bytes32 => bool) public depositUsed;
    address public allocator;
    bool public shouldRevert;

    error MockRevert();

    event DepositNative(
        address indexed depositor,
        bytes32 indexed id,
        uint256 amount
    );
    event DepositErc20(
        address indexed depositor,
        address indexed token,
        uint256 amount,
        bytes32 indexed id
    );

    constructor(address _allocator) {
        allocator = _allocator;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function depositNative(
        address depositor,
        bytes32 id
    ) external payable override {
        if (shouldRevert) {
            revert MockRevert();
        }
        depositUsed[id] = true;
        emit DepositNative(depositor, id, msg.value);
    }

    function depositErc20(
        address depositor,
        address token,
        uint256 amount,
        bytes32 id
    ) external override {
        if (shouldRevert) {
            revert MockRevert();
        }
        // Transfer tokens from the caller
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        depositUsed[id] = true;
        emit DepositErc20(depositor, token, amount, id);
    }

    function depositErc20(
        address depositor,
        address token,
        bytes32 id
    ) external override {
        if (shouldRevert) {
            revert MockRevert();
        }
        // Get allowance and transfer
        uint256 allowance = IERC20(token).allowance(msg.sender, address(this));
        IERC20(token).transferFrom(msg.sender, address(this), allowance);
        depositUsed[id] = true;
        emit DepositErc20(depositor, token, allowance, id);
    }

    function getAllocator() external view override returns (address) {
        return allocator;
    }
}
