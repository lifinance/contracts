// Note: All Safe addresses for each chain are stored in config/networks.json
// We no longer need the utility contract addresses as we only interact with the Safe directly

// Safe contract ABIs using Viem's human-readable format
export const SAFE_SINGLETON_ABI = [
  // View functions
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function approvedHashes(bytes32 hashToApprove) view returns (uint256)',

  // State-changing functions
  'function addOwnerWithThreshold(address owner, uint256 _threshold) nonpayable',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold) nonpayable',
  'function changeThreshold(uint256 _threshold) nonpayable',

  // Transaction execution
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) nonpayable returns (bool success)',

  // Transaction hash
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
] as const
