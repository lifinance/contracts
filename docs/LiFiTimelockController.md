# LiFiTimelockController

## Description

The LiFiTimelockController is a custom implementation of OpenZeppelin's TimelockController that provides timelock functionality for changes on LI.FI's production diamonds. It ensures that any changes to the diamond contract must go through a time-delayed approval process, providing security against immediate malicious changes.

## Key Features

- **Timelock Protection**: All changes must wait for a minimum delay period before execution
- **Role-Based Access Control**: Different roles for proposing, executing, and cancelling operations
- **Emergency Unpause**: Bypasses timelock delay for fast emergency unpausing of the diamond
- **Diamond Address Management**: Ability to update the controlled diamond address

## Roles

The timelock uses the following roles from OpenZeppelin's TimelockController:

- **TIMELOCK_ADMIN_ROLE**: Can grant/revoke other roles and update diamond address
- **PROPOSER_ROLE**: Can schedule operations for execution
- **EXECUTOR_ROLE**: Can execute scheduled operations after the delay period
- **CANCELLER_ROLE**: Can cancel scheduled operations

## How To Use

### Constructor Parameters

```solidity
constructor(
    uint256 _minDelay,           // Minimum delay for operations (e.g., 1 day)
    address[] memory _proposers, // Addresses that can propose operations
    address[] memory _executors, // Addresses that can execute operations
    address _cancellerWallet,    // Address that can cancel operations
    address _admin,              // Admin address (LiFi MultiSig SAFE)
    address _diamond             // Address of the diamond to control
)
```

### Scheduling Operations

Use the `schedule` function to propose operations that will be executed after the minimum delay:

```solidity
/// @notice Schedule an operation for execution
/// @param target Target contract for the operation
/// @param value ETH value for the operation
/// @param data Calldata for the operation
/// @param predecessor Predecessor operation (bytes32(0) for none)
/// @param salt Unique identifier for the operation
/// @param delay Delay before execution (must be >= minDelay)
function schedule(
    address target,
    uint256 value,
    bytes calldata data,
    bytes32 predecessor,
    bytes32 salt,
    uint256 delay
) external onlyRole(PROPOSER_ROLE)
```

### Executing Operations

After the delay period, use the `execute` function to execute scheduled operations:

```solidity
/// @notice Execute a scheduled operation
/// @param target Target contract for the operation
/// @param value ETH value for the operation
/// @param data Calldata for the operation
/// @param predecessor Predecessor operation
/// @param salt Unique identifier for the operation
function execute(
    address target,
    uint256 value,
    bytes calldata data,
    bytes32 predecessor,
    bytes32 salt
) external payable onlyRoleOrOpenRole(EXECUTOR_ROLE)
```

### Emergency Unpause

The timelock can unpause the diamond without delay in emergency situations:

```solidity
/// @notice Unpauses the diamond contract by re-adding all facetAddress-to-function-selector mappings
/// @dev Can only be executed by the TimelockController admin
/// @param _blacklist The address(es) of facet(s) that should not be reactivated
function unpauseDiamond(
    address[] calldata _blacklist
) external onlyRole(TIMELOCK_ADMIN_ROLE)
```

### Updating Diamond Address

The admin can update the controlled diamond address:

```solidity
/// @notice Updates the address of the diamond contract
/// @dev Can only be called by admin role
/// @param _diamond The new diamond address to set
function setDiamondAddress(
    address _diamond
) external onlyRole(TIMELOCK_ADMIN_ROLE)
```

## Configuration

The timelock requires the following configuration parameters:

- **minDelay**: Minimum delay for operations (typically 1 day for production)
- **proposers**: Array of addresses that can propose operations (usually the LiFi MultiSig)
- **executors**: Array of addresses that can execute operations (can be address(0) for anyone)
- **cancellerWallet**: Address that can cancel operations (usually the deployer wallet)
- **admin**: Admin address (LiFi MultiSig SAFE)
- **diamond**: Address of the diamond contract to control

## Security Considerations

- The `unpauseDiamond` function intentionally bypasses the timelock delay for emergency situations
- Only the admin can update the diamond address or unpause the diamond
- All other operations must go through the standard timelock process
- The timelock inherits all security features from OpenZeppelin's TimelockController

## Events

```solidity
/// @notice Emitted when the diamond address is updated
/// @param diamond The new diamond address
event DiamondAddressUpdated(address indexed diamond);
```

## Error Handling

The contract reverts with `InvalidConfig` error if any constructor parameter is invalid (zero address, zero delay, empty arrays).
