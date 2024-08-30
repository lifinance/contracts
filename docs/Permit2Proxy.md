# Permit2 Proxy

## Description

Periphery contract which enables gasless and semi-gasless transaction flows
enabled through ERC20 Permit and Uniswap's Permit2

## How To Use

The contract has a number of methods for making gasless and semi-gasless calls
as well as a few helpful utility methods.

The following methods are available:

This method is used to execute a transaction where the approval is granted
using an ERC20 Permit signature. It can only be called by the signer in order
to prevent front-running attacks.

```solidity
/// @notice Allows to bridge tokens through a LI.FI diamond contract using
/// an EIP2612 gasless permit (only works with tokenAddresses that
/// implement EIP2612) (in contrast to Permit2, calldata and diamondAddress
/// are not signed by the user and could therefore be replaced by the user)
/// Can only be called by the permit signer to prevent front-running.
/// @param tokenAddress Address of the token to be bridged
/// @param amount Amount of tokens to be bridged
/// @param deadline Transaction must be completed before this timestamp
/// @param v User signature (recovery ID)
/// @param r User signature (ECDSA output)
/// @param s User signature (ECDSA output)
/// @param diamondCalldata Address of the token to be bridged
function callDiamondWithEIP2612Signature(
    address tokenAddress,
    uint256 amount,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s,
    bytes calldata diamondCalldata
) public payable 
````

This method is used to execute a transaction where the approval is granted via
Uniswap's Permit2 contract. It can only be called by the signer in order to
prevent front-running attacks.

```solidity
/// @notice Allows to bridge tokens of one type through a LI.FI diamond
///         contract using Uniswap's Permit2 contract and a user signature
///         that verifies allowance. The calldata can be changed by the
///         user. Can only be called by the permit signer to prevent
///         front-running.
/// @param _diamondCalldata the calldata to execute
/// @param _permit the Uniswap Permit2 parameters
/// @param _signature the signature giving approval to transfer tokens
function callDiamondWithPermit2(
    bytes calldata _diamondCalldata,
    ISignatureTransfer.PermitTransferFrom calldata _permit,
    bytes calldata _signature
) external payable
```

This method enables a gasless flow by allowing a user to sign a Uniswap Permit2
message hash which includes a "witness" type. This extra type restricts which
calldata can be called during execution and cannot be changed. Anyone with the
signature can execute the transaction on behalf of the signer.

```solidity
/// @notice Allows to bridge tokens of one type through a LI.FI diamond
///         contract using Uniswap's Permit2 contract and a user signature
///         that verifies allowance, diamondAddress and diamondCalldata
/// @param _diamondCalldata the calldata to execute
/// @param _signer the signer giving permission to transfer tokens
/// @param _permit the Uniswap Permit2 parameters
/// @param _signature the signature giving approval to transfer tokens
function callDiamondWithPermit2Witness(
    bytes calldata _diamondCalldata,
    address _signer,
    ISignatureTransfer.PermitTransferFrom calldata _permit,
    bytes calldata _signature
) external payable
```

There are a few utility methods to make it easier to generate the necessary
signature for the gasless flow.

Calling this method will return a valid message hash that can then be signed
in order to be executed later by another wallet.

```solidity
/// @notice utitlity method for constructing a valid Permit2 message hash
/// @param _diamondCalldata the calldata to execute
/// @param _assetId the address of the token to approve
/// @param _amount amount of tokens to approve
/// @param _nonce the nonce to use
/// @param _deadline the expiration deadline
function getPermit2MsgHash(
    bytes calldata _diamondCalldata,
    address _assetId,
    uint256 _amount,
    uint256 _nonce,
    uint256 _deadline
) external view returns (bytes32 msgHash)
```

Permit2 nonces are non-sequential and are a bit complicated to work with the
following utility methods allow you to fetch the next valid nonce or sequence
of nonces for use when generating Permit2 signatures.

```solidity
/// @notice Finds the next valid nonce for a user, starting from 0.
/// @param owner The owner of the nonces
/// @return nonce The first valid nonce starting from 0
function nextNonce(address owner) external view returns (uint256 nonce)

/// @notice Finds the next valid nonce for a user, after from a given nonce.
/// @dev This can be helpful if you're signing multiple nonces in a row and 
///      need the next nonce to sign but the start one is still valid.
/// @param owner The owner of the nonces
/// @param start The nonce to start from
/// @return nonce The first valid nonce after the given nonce
function nextNonceAfter(
    address owner,
    uint256 start
) external view returns (uint256 nonce)
```
