# Access Manager Facet

## Description

Manages method level access control for diamond methods

## How To Use

Use the `setCanExecute` method to grant/revoke access to addresses for a specific method

```solidity
/// @notice Sets whether a specific address can call a method
/// @param _selector The method selector to set access for
/// @param _executor The address to set method access for
/// @param _canExecute Whether or not the address can execute the specified method
function setCanExecute(
  bytes4 _selector,
  address _executor,
  bool _canExecute
) external
```

Use the `addressCanExecuteMethod` to check whether an address can execute a specific method

```solidity
/// @notice Check if a method can be executed by a specific address
/// @param _selector The method selector to check
/// @param _executor The address to check
function addressCanExecuteMethod(
  bytes4 _selector,
  address _executor
) external view returns (bool)
```
