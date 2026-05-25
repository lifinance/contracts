// Note: All Safe addresses for each chain are stored in config/networks.json
// We no longer need the utility contract addresses as we only interact with the Safe directly

// Safe contract ABIs using explicit JSON format for better Viem compatibility
export const SAFE_SINGLETON_ABI = [
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'nonce',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'hashToApprove', type: 'bytes32' },
    ],
    name: 'approvedHashes',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: '_threshold', type: 'uint256' },
    ],
    name: 'addOwnerWithThreshold',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'prevOwner', type: 'address' },
      { name: 'owner', type: 'address' },
      { name: '_threshold', type: 'uint256' },
    ],
    name: 'removeOwner',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: '_threshold', type: 'uint256' }],
    name: 'changeThreshold',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    name: 'execTransaction',
    outputs: [{ name: 'success', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    name: 'getTransactionHash',
    outputs: [{ type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Safe execution outcome events. Neither parameter is `indexed` in Safe
// v1.3.0+ — match the on-chain layout exactly so viem decodes from `data`.
// Used by reconciliation to scan past executions when the script lost track
// of an in-flight tx (e.g. RPC dropped after broadcast).
export const SAFE_EVENTS_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: 'txHash', type: 'bytes32' },
      { indexed: false, name: 'payment', type: 'uint256' },
    ],
    name: 'ExecutionSuccess',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, name: 'txHash', type: 'bytes32' },
      { indexed: false, name: 'payment', type: 'uint256' },
    ],
    name: 'ExecutionFailure',
    type: 'event',
  },
] as const
