// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

error InvalidAmount();
error TokenAddressIsZero();
error CannotBridgeToSameNetwork();
error ZeroPostSwapBalance();
error InvalidBridgeConfigLength();
error NoSwapDataProvided();
error NativeValueWithERC();
error ContractCallNotAllowed();
error NullAddrIsNotAValidSpender();
error NullAddrIsNotAnERC20Token();
error NoTransferToNullAddress();
error NativeAssetTransferFailed();
error InvalidContract();
error InvalidConfig();
error UnsupportedChainId(uint256 chainId);
