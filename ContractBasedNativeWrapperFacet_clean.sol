// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

// src/Periphery/LDA/BaseRouteConstants.sol

/// @title BaseRouteConstants
/// @author LI.FI (https://li.fi)
/// @notice Base contract providing common constants for DEX facets
/// @dev Abstract contract with shared constants to avoid duplication across facets
/// @custom:version 1.0.0
abstract contract BaseRouteConstants {
    /// @dev Constant indicating swap direction from token0 to token1
    uint8 internal constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;

    /// @dev A sentinel address (address(1)) used in the `from` parameter of a swap.
    /// It signals that the input tokens for the swap are already held by the
    /// receiving contract (e.g., from a previous swap in a multi-step route).
    /// This tells the facet to use its current token balance instead of
    /// pulling funds from an external address via `transferFrom`.
    address internal constant FUNDS_IN_RECEIVER = address(1);
}

// src/Errors/GenericErrors.sol

/// @custom:version 1.0.2

error AlreadyInitialized();
error CannotAuthoriseSelf();
error CannotBridgeToSameNetwork();
error ContractCallNotAllowed();
error CumulativeSlippageTooHigh(uint256 minAmount, uint256 receivedAmount);
error DiamondIsPaused();
error ETHTransferFailed();
error ExternalCallFailed();
error FunctionDoesNotExist();
error InformationMismatch();
error InsufficientBalance(uint256 required, uint256 balance);
error InvalidAmount();
error InvalidCallData();
error InvalidConfig();
error InvalidContract();
error InvalidDestinationChain();
error InvalidFallbackAddress();
error InvalidNonEVMReceiver();
error InvalidReceiver();
error InvalidSendingToken();
error NativeAssetNotSupported();
error NativeAssetTransferFailed();
error NoSwapDataProvided();
error NoSwapFromZeroBalance();
error NotAContract();
error NotInitialized();
error NoTransferToNullAddress();
error NullAddrIsNotAnERC20Token();
error NullAddrIsNotAValidSpender();
error OnlyContractOwner();
error RecoveryAddressCannotBeZero();
error ReentrancyError();
error TokenNotSupported();
error TransferFromFailed();
error UnAuthorized();
error UnsupportedChainId(uint256 chainId);
error WithdrawFailed();
error ZeroAmount();

// lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol

// OpenZeppelin Contracts (last updated v4.9.0) (token/ERC20/IERC20.sol)

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    /**
     * @dev Returns the amount of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the amount of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves `amount` tokens from the caller's account to `to`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address to, uint256 amount) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);

    /**
     * @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 amount) external returns (bool);

    /**
     * @dev Moves `amount` tokens from `from` to `to` using the
     * allowance mechanism. `amount` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

// src/Libraries/LibBytes.sol

/// @custom:version 1.0.0

library LibBytes {
    // solhint-disable no-inline-assembly

    // LibBytes specific errors
    error SliceOverflow();
    error SliceOutOfBounds();
    error AddressOutOfBounds();

    bytes16 private constant _SYMBOLS = "0123456789abcdef";

    // -------------------------

    function slice(
        bytes memory _bytes,
        uint256 _start,
        uint256 _length
    ) internal pure returns (bytes memory) {
        if (_length + 31 < _length) revert SliceOverflow();
        if (_bytes.length < _start + _length) revert SliceOutOfBounds();

        bytes memory tempBytes;

        assembly {
            switch iszero(_length)
            case 0 {
                // Get a location of some free memory and store it in tempBytes as
                // Solidity does for memory variables.
                tempBytes := mload(0x40)

                // The first word of the slice result is potentially a partial
                // word read from the original array. To read it, we calculate
                // the length of that partial word and start copying that many
                // bytes into the array. The first word we copy will start with
                // data we don't care about, but the last `lengthmod` bytes will
                // land at the beginning of the contents of the new array. When
                // we're done copying, we overwrite the full first word with
                // the actual length of the slice.
                let lengthmod := and(_length, 31)

                // The multiplication in the next line is necessary
                // because when slicing multiples of 32 bytes (lengthmod == 0)
                // the following copy loop was copying the origin's length
                // and then ending prematurely not copying everything it should.
                let mc := add(
                    add(tempBytes, lengthmod),
                    mul(0x20, iszero(lengthmod))
                )
                let end := add(mc, _length)

                for {
                    // The multiplication in the next line has the same exact purpose
                    // as the one above.
                    let cc := add(
                        add(
                            add(_bytes, lengthmod),
                            mul(0x20, iszero(lengthmod))
                        ),
                        _start
                    )
                } lt(mc, end) {
                    mc := add(mc, 0x20)
                    cc := add(cc, 0x20)
                } {
                    mstore(mc, mload(cc))
                }

                mstore(tempBytes, _length)

                //update free-memory pointer
                //allocating the array padded to 32 bytes like the compiler does now
                mstore(0x40, and(add(mc, 31), not(31)))
            }
            //if we want a zero-length slice let's just return a zero-length array
            default {
                tempBytes := mload(0x40)
                //zero out the 32 bytes slice we are about to return
                //we need to do it because Solidity does not garbage collect
                mstore(tempBytes, 0)

                mstore(0x40, add(tempBytes, 0x20))
            }
        }

        return tempBytes;
    }

    function toAddress(
        bytes memory _bytes,
        uint256 _start
    ) internal pure returns (address) {
        if (_bytes.length < _start + 20) {
            revert AddressOutOfBounds();
        }
        address tempAddress;

        assembly {
            tempAddress := div(
                mload(add(add(_bytes, 0x20), _start)),
                0x1000000000000000000000000
            )
        }

        return tempAddress;
    }

    /// Copied from OpenZeppelin's `Strings.sol` utility library.
    /// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/8335676b0e99944eef6a742e16dcd9ff6e68e609
    /// /contracts/utils/Strings.sol
    function toHexString(
        uint256 value,
        uint256 length
    ) internal pure returns (string memory) {
        bytes memory buffer = new bytes(2 * length + 2);
        buffer[0] = "0";
        buffer[1] = "x";
        for (uint256 i = 2 * length + 1; i > 1; --i) {
            buffer[i] = _SYMBOLS[value & 0xf];
            value >>= 4;
        }
        // solhint-disable-next-line gas-custom-errors
        require(value == 0, "Strings: hex length insufficient");
        return string(buffer);
    }
}

// src/Libraries/LibPackedStream.sol

/// @title LibPackedStream
/// @author LI.FI (https://li.fi)
/// @notice A library for reading compact byte streams with minimal overhead
/// @dev Provides functions to read various integer types and addresses from a byte stream.
///      All integer reads are big-endian. The stream pointer advances after each read.
/// @custom:version 1.0.0
library LibPackedStream {
    /// @notice Returns the start and finish pointers for a bytes array
    /// @param data The bytes array to get bounds for
    /// @return start The pointer to the start of the actual bytes data (after length prefix)
    /// @return finish The pointer to the end of the bytes data
    function _bounds(
        bytes memory data
    ) private pure returns (uint256 start, uint256 finish) {
        assembly {
            start := add(data, 32)
            finish := add(start, mload(data))
        }
    }

    /// @notice Creates a new stream from a bytes array
    /// @dev Allocates memory for stream pointers and initializes them
    /// @param data The source bytes to create a stream from
    /// @return stream A pointer to the stream struct (contains current position and end)
    function createStream(
        bytes memory data
    ) internal pure returns (uint256 stream) {
        (uint256 start, uint256 finish) = _bounds(data);
        assembly {
            stream := mload(0x40)
            mstore(stream, start)
            mstore(add(stream, 32), finish)
            mstore(0x40, add(stream, 64))
        }
    }

    /// @notice Checks if there are unread bytes in the stream
    /// @param stream The stream to check
    /// @return True if current position is before end of stream
    function isNotEmpty(uint256 stream) internal pure returns (bool) {
        uint256 pos;
        uint256 finish;
        assembly {
            pos := mload(stream)
            finish := mload(add(stream, 32))
        }
        return pos < finish;
    }

    /// @notice Reads a uint8 from the current stream position
    /// @dev Reads 1 byte and advances stream by 1
    /// @param stream The stream to read from
    /// @return res The uint8 value read
    function readUint8(uint256 stream) internal pure returns (uint8 res) {
        assembly {
            let pos := mload(stream)
            res := byte(0, mload(pos))
            mstore(stream, add(pos, 1))
        }
    }

    /// @notice Reads a uint16 from the current stream position
    /// @dev Reads 2 bytes big-endian and advances stream by 2
    /// @param stream The stream to read from
    /// @return res The uint16 value read
    function readUint16(uint256 stream) internal pure returns (uint16 res) {
        assembly {
            let pos := mload(stream)
            res := shr(240, mload(pos))
            mstore(stream, add(pos, 2))
        }
    }

    /// @notice Reads a uint24 from the current stream position
    /// @dev Reads 3 bytes big-endian and advances stream by 3
    /// @param stream The stream to read from
    /// @return res The uint24 value read
    function readUint24(uint256 stream) internal pure returns (uint24 res) {
        assembly {
            let pos := mload(stream)
            res := shr(232, mload(pos))
            mstore(stream, add(pos, 3))
        }
    }

    /// @notice Reads a uint256 from the current stream position
    /// @dev Reads 32 bytes and advances stream by 32
    /// @param stream The stream to read from
    /// @return res The uint256 value read
    function readUint256(uint256 stream) internal pure returns (uint256 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 32))
        }
    }

    /// @notice Reads a bytes32 from the current stream position
    /// @dev Reads 32 bytes and advances stream by 32
    /// @param stream The stream to read from
    /// @return res The bytes32 value read
    function readBytes32(uint256 stream) internal pure returns (bytes32 res) {
        assembly {
            let pos := mload(stream)
            res := mload(pos)
            mstore(stream, add(pos, 32))
        }
    }

    /// @notice Reads an address from the current stream position
    /// @dev Reads 20 bytes and advances stream by 20
    /// @param stream The stream to read from
    /// @return res The address value read
    function readAddress(uint256 stream) internal pure returns (address res) {
        assembly {
            let pos := mload(stream)
            res := shr(96, mload(pos))
            mstore(stream, add(pos, 20))
        }
    }

    /// @notice Reads a length-prefixed byte array from the stream
    /// @dev Format: [uint16 length][bytes data]. Used for multi-hop routes where each hop's
    ///      data is prefixed with its length. Example of a 2-hop route encoding:
    ///      [uint16 hop1_len][bytes hop1_data][uint16 hop2_len][bytes hop2_data]
    /// @param stream The stream to read from
    /// @return res The bytes array read from the stream (without length prefix)
    function readBytesWithLength(
        uint256 stream
    ) internal view returns (bytes memory res) {
        // Read the 2-byte length prefix
        uint16 len = LibPackedStream.readUint16(stream);

        if (len > 0) {
            uint256 pos;
            assembly {
                pos := mload(stream)
            }
            assembly {
                // Allocate memory for result
                res := mload(0x40)
                mstore(0x40, add(res, add(len, 32)))
                // Store length and copy data
                mstore(res, len)
                pop(staticcall(gas(), 4, pos, len, add(res, 32), len))
                // Advance stream pointer
                mstore(stream, add(pos, len))
            }
        }
    }
}

// lib/solady/src/utils/SafeTransferLib.sol

/// @notice Safe ETH and ERC20 transfer library that gracefully handles missing return values.
/// @author Solady (https://github.com/vectorized/solady/blob/main/src/utils/SafeTransferLib.sol)
/// @author Modified from Solmate (https://github.com/transmissions11/solmate/blob/main/src/utils/SafeTransferLib.sol)
/// @author Permit2 operations from (https://github.com/Uniswap/permit2/blob/main/src/libraries/Permit2Lib.sol)
///
/// @dev Note:
/// - For ETH transfers, please use `forceSafeTransferETH` for DoS protection.
/// - For ERC20s, this implementation won't check that a token has code,
///   responsibility is delegated to the caller.
library SafeTransferLib {
    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The ETH transfer has failed.
    error ETHTransferFailed();

    /// @dev The ERC20 `transferFrom` has failed.
    error TransferFromFailed();

    /// @dev The ERC20 `transfer` has failed.
    error TransferFailed();

    /// @dev The ERC20 `approve` has failed.
    error ApproveFailed();

    /// @dev The Permit2 operation has failed.
    error Permit2Failed();

    /// @dev The Permit2 amount must be less than `2**160 - 1`.
    error Permit2AmountOverflow();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Suggested gas stipend for contract receiving ETH that disallows any storage writes.
    uint256 internal constant GAS_STIPEND_NO_STORAGE_WRITES = 2300;

    /// @dev Suggested gas stipend for contract receiving ETH to perform a few
    /// storage reads and writes, but low enough to prevent griefing.
    uint256 internal constant GAS_STIPEND_NO_GRIEF = 100000;

    /// @dev The unique EIP-712 domain domain separator for the DAI token contract.
    bytes32 internal constant DAI_DOMAIN_SEPARATOR =
        0xdbb8cf42e1ecb028be3f3dbc922e1d878b963f411dc388ced501601c60f7c6f7;

    /// @dev The address for the WETH9 contract on Ethereum mainnet.
    address internal constant WETH9 =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    /// @dev The canonical Permit2 address.
    /// [Github](https://github.com/Uniswap/permit2)
    /// [Etherscan](https://etherscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3)
    address internal constant PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       ETH OPERATIONS                       */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    // If the ETH transfer MUST succeed with a reasonable gas budget, use the force variants.
    //
    // The regular variants:
    // - Forwards all remaining gas to the target.
    // - Reverts if the target reverts.
    // - Reverts if the current contract has insufficient balance.
    //
    // The force variants:
    // - Forwards with an optional gas stipend
    //   (defaults to `GAS_STIPEND_NO_GRIEF`, which is sufficient for most cases).
    // - If the target reverts, or if the gas stipend is exhausted,
    //   creates a temporary contract to force send the ETH via `SELFDESTRUCT`.
    //   Future compatible with `SENDALL`: https://eips.ethereum.org/EIPS/eip-4758.
    // - Reverts if the current contract has insufficient balance.
    //
    // The try variants:
    // - Forwards with a mandatory gas stipend.
    // - Instead of reverting, returns whether the transfer succeeded.

    /// @dev Sends `amount` (in wei) ETH to `to`.
    function safeTransferETH(address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            if iszero(
                call(gas(), to, amount, codesize(), 0x00, codesize(), 0x00)
            ) {
                mstore(0x00, 0xb12d13eb) // `ETHTransferFailed()`.
                revert(0x1c, 0x04)
            }
        }
    }

    /// @dev Sends all the ETH in the current contract to `to`.
    function safeTransferAllETH(address to) internal {
        /// @solidity memory-safe-assembly
        assembly {
            // Transfer all the ETH and check if it succeeded or not.
            if iszero(
                call(
                    gas(),
                    to,
                    selfbalance(),
                    codesize(),
                    0x00,
                    codesize(),
                    0x00
                )
            ) {
                mstore(0x00, 0xb12d13eb) // `ETHTransferFailed()`.
                revert(0x1c, 0x04)
            }
        }
    }

    /// @dev Force sends `amount` (in wei) ETH to `to`, with a `gasStipend`.
    function forceSafeTransferETH(
        address to,
        uint256 amount,
        uint256 gasStipend
    ) internal {
        /// @solidity memory-safe-assembly
        assembly {
            if lt(selfbalance(), amount) {
                mstore(0x00, 0xb12d13eb) // `ETHTransferFailed()`.
                revert(0x1c, 0x04)
            }
            if iszero(
                call(
                    gasStipend,
                    to,
                    amount,
                    codesize(),
                    0x00,
                    codesize(),
                    0x00
                )
            ) {
                mstore(0x00, to) // Store the address in scratch space.
                mstore8(0x0b, 0x73) // Opcode `PUSH20`.
                mstore8(0x20, 0xff) // Opcode `SELFDESTRUCT`.
                if iszero(create(amount, 0x0b, 0x16)) {
                    revert(codesize(), codesize())
                } // For gas estimation.
            }
        }
    }

    /// @dev Force sends all the ETH in the current contract to `to`, with a `gasStipend`.
    function forceSafeTransferAllETH(address to, uint256 gasStipend) internal {
        /// @solidity memory-safe-assembly
        assembly {
            if iszero(
                call(
                    gasStipend,
                    to,
                    selfbalance(),
                    codesize(),
                    0x00,
                    codesize(),
                    0x00
                )
            ) {
                mstore(0x00, to) // Store the address in scratch space.
                mstore8(0x0b, 0x73) // Opcode `PUSH20`.
                mstore8(0x20, 0xff) // Opcode `SELFDESTRUCT`.
                if iszero(create(selfbalance(), 0x0b, 0x16)) {
                    revert(codesize(), codesize())
                } // For gas estimation.
            }
        }
    }

    /// @dev Force sends `amount` (in wei) ETH to `to`, with `GAS_STIPEND_NO_GRIEF`.
    function forceSafeTransferETH(address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            if lt(selfbalance(), amount) {
                mstore(0x00, 0xb12d13eb) // `ETHTransferFailed()`.
                revert(0x1c, 0x04)
            }
            if iszero(
                call(
                    GAS_STIPEND_NO_GRIEF,
                    to,
                    amount,
                    codesize(),
                    0x00,
                    codesize(),
                    0x00
                )
            ) {
                mstore(0x00, to) // Store the address in scratch space.
                mstore8(0x0b, 0x73) // Opcode `PUSH20`.
                mstore8(0x20, 0xff) // Opcode `SELFDESTRUCT`.
                if iszero(create(amount, 0x0b, 0x16)) {
                    revert(codesize(), codesize())
                } // For gas estimation.
            }
        }
    }

    /// @dev Force sends all the ETH in the current contract to `to`, with `GAS_STIPEND_NO_GRIEF`.
    function forceSafeTransferAllETH(address to) internal {
        /// @solidity memory-safe-assembly
        assembly {
            // forgefmt: disable-next-item
            if iszero(
                call(
                    GAS_STIPEND_NO_GRIEF,
                    to,
                    selfbalance(),
                    codesize(),
                    0x00,
                    codesize(),
                    0x00
                )
            ) {
                mstore(0x00, to) // Store the address in scratch space.
                mstore8(0x0b, 0x73) // Opcode `PUSH20`.
                mstore8(0x20, 0xff) // Opcode `SELFDESTRUCT`.
                if iszero(create(selfbalance(), 0x0b, 0x16)) {
                    revert(codesize(), codesize())
                } // For gas estimation.
            }
        }
    }

    /// @dev Sends `amount` (in wei) ETH to `to`, with a `gasStipend`.
    function trySafeTransferETH(
        address to,
        uint256 amount,
        uint256 gasStipend
    ) internal returns (bool success) {
        /// @solidity memory-safe-assembly
        assembly {
            success := call(
                gasStipend,
                to,
                amount,
                codesize(),
                0x00,
                codesize(),
                0x00
            )
        }
    }

    /// @dev Sends all the ETH in the current contract to `to`, with a `gasStipend`.
    function trySafeTransferAllETH(
        address to,
        uint256 gasStipend
    ) internal returns (bool success) {
        /// @solidity memory-safe-assembly
        assembly {
            success := call(
                gasStipend,
                to,
                selfbalance(),
                codesize(),
                0x00,
                codesize(),
                0x00
            )
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      ERC20 OPERATIONS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Sends `amount` of ERC20 `token` from `from` to `to`.
    /// Reverts upon failure.
    ///
    /// The `from` account must have at least `amount` approved for
    /// the current contract to manage.
    function safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40) // Cache the free memory pointer.
            mstore(0x60, amount) // Store the `amount` argument.
            mstore(0x40, to) // Store the `to` argument.
            mstore(0x2c, shl(96, from)) // Store the `from` argument.
            mstore(0x0c, 0x23b872dd000000000000000000000000) // `transferFrom(address,address,uint256)`.
            // Perform the transfer, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                    call(gas(), token, 0, 0x1c, 0x64, 0x00, 0x20)
                )
            ) {
                mstore(0x00, 0x7939f424) // `TransferFromFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x60, 0) // Restore the zero slot to zero.
            mstore(0x40, m) // Restore the free memory pointer.
        }
    }

    /// @dev Sends `amount` of ERC20 `token` from `from` to `to`.
    ///
    /// The `from` account must have at least `amount` approved for the current contract to manage.
    function trySafeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal returns (bool success) {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40) // Cache the free memory pointer.
            mstore(0x60, amount) // Store the `amount` argument.
            mstore(0x40, to) // Store the `to` argument.
            mstore(0x2c, shl(96, from)) // Store the `from` argument.
            mstore(0x0c, 0x23b872dd000000000000000000000000) // `transferFrom(address,address,uint256)`.
            success := and(
                // The arguments of `and` are evaluated from right to left.
                or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                call(gas(), token, 0, 0x1c, 0x64, 0x00, 0x20)
            )
            mstore(0x60, 0) // Restore the zero slot to zero.
            mstore(0x40, m) // Restore the free memory pointer.
        }
    }

    /// @dev Sends all of ERC20 `token` from `from` to `to`.
    /// Reverts upon failure.
    ///
    /// The `from` account must have their entire balance approved for the current contract to manage.
    function safeTransferAllFrom(
        address token,
        address from,
        address to
    ) internal returns (uint256 amount) {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40) // Cache the free memory pointer.
            mstore(0x40, to) // Store the `to` argument.
            mstore(0x2c, shl(96, from)) // Store the `from` argument.
            mstore(0x0c, 0x70a08231000000000000000000000000) // `balanceOf(address)`.
            // Read the balance, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    gt(returndatasize(), 0x1f), // At least 32 bytes returned.
                    staticcall(gas(), token, 0x1c, 0x24, 0x60, 0x20)
                )
            ) {
                mstore(0x00, 0x7939f424) // `TransferFromFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x00, 0x23b872dd) // `transferFrom(address,address,uint256)`.
            amount := mload(0x60) // The `amount` is already at 0x60. We'll need to return it.
            // Perform the transfer, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                    call(gas(), token, 0, 0x1c, 0x64, 0x00, 0x20)
                )
            ) {
                mstore(0x00, 0x7939f424) // `TransferFromFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x60, 0) // Restore the zero slot to zero.
            mstore(0x40, m) // Restore the free memory pointer.
        }
    }

    /// @dev Sends `amount` of ERC20 `token` from the current contract to `to`.
    /// Reverts upon failure.
    function safeTransfer(address token, address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, to) // Store the `to` argument.
            mstore(0x34, amount) // Store the `amount` argument.
            mstore(0x00, 0xa9059cbb000000000000000000000000) // `transfer(address,uint256)`.
            // Perform the transfer, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                    call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
                )
            ) {
                mstore(0x00, 0x90b8ec18) // `TransferFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x34, 0) // Restore the part of the free memory pointer that was overwritten.
        }
    }

    /// @dev Sends all of ERC20 `token` from the current contract to `to`.
    /// Reverts upon failure.
    function safeTransferAll(
        address token,
        address to
    ) internal returns (uint256 amount) {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x00, 0x70a08231) // Store the function selector of `balanceOf(address)`.
            mstore(0x20, address()) // Store the address of the current contract.
            // Read the balance, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    gt(returndatasize(), 0x1f), // At least 32 bytes returned.
                    staticcall(gas(), token, 0x1c, 0x24, 0x34, 0x20)
                )
            ) {
                mstore(0x00, 0x90b8ec18) // `TransferFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x14, to) // Store the `to` argument.
            amount := mload(0x34) // The `amount` is already at 0x34. We'll need to return it.
            mstore(0x00, 0xa9059cbb000000000000000000000000) // `transfer(address,uint256)`.
            // Perform the transfer, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                    call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
                )
            ) {
                mstore(0x00, 0x90b8ec18) // `TransferFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x34, 0) // Restore the part of the free memory pointer that was overwritten.
        }
    }

    /// @dev Sets `amount` of ERC20 `token` for `to` to manage on behalf of the current contract.
    /// Reverts upon failure.
    function safeApprove(address token, address to, uint256 amount) internal {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, to) // Store the `to` argument.
            mstore(0x34, amount) // Store the `amount` argument.
            mstore(0x00, 0x095ea7b3000000000000000000000000) // `approve(address,uint256)`.
            // Perform the approval, reverting upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                    call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
                )
            ) {
                mstore(0x00, 0x3e3f8f73) // `ApproveFailed()`.
                revert(0x1c, 0x04)
            }
            mstore(0x34, 0) // Restore the part of the free memory pointer that was overwritten.
        }
    }

    /// @dev Sets `amount` of ERC20 `token` for `to` to manage on behalf of the current contract.
    /// If the initial attempt to approve fails, attempts to reset the approved amount to zero,
    /// then retries the approval again (some tokens, e.g. USDT, requires this).
    /// Reverts upon failure.
    function safeApproveWithRetry(
        address token,
        address to,
        uint256 amount
    ) internal {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, to) // Store the `to` argument.
            mstore(0x34, amount) // Store the `amount` argument.
            mstore(0x00, 0x095ea7b3000000000000000000000000) // `approve(address,uint256)`.
            // Perform the approval, retrying upon failure.
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                    call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
                )
            ) {
                mstore(0x34, 0) // Store 0 for the `amount`.
                mstore(0x00, 0x095ea7b3000000000000000000000000) // `approve(address,uint256)`.
                pop(call(gas(), token, 0, 0x10, 0x44, codesize(), 0x00)) // Reset the approval.
                mstore(0x34, amount) // Store back the original `amount`.
                // Retry the approval, reverting upon failure.
                if iszero(
                    and(
                        or(eq(mload(0x00), 1), iszero(returndatasize())), // Returned 1 or nothing.
                        call(gas(), token, 0, 0x10, 0x44, 0x00, 0x20)
                    )
                ) {
                    mstore(0x00, 0x3e3f8f73) // `ApproveFailed()`.
                    revert(0x1c, 0x04)
                }
            }
            mstore(0x34, 0) // Restore the part of the free memory pointer that was overwritten.
        }
    }

    /// @dev Returns the amount of ERC20 `token` owned by `account`.
    /// Returns zero if the `token` does not exist.
    function balanceOf(
        address token,
        address account
    ) internal view returns (uint256 amount) {
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x14, account) // Store the `account` argument.
            mstore(0x00, 0x70a08231000000000000000000000000) // `balanceOf(address)`.
            amount := mul(
                // The arguments of `mul` are evaluated from right to left.
                mload(0x20),
                and(
                    // The arguments of `and` are evaluated from right to left.
                    gt(returndatasize(), 0x1f), // At least 32 bytes returned.
                    staticcall(gas(), token, 0x10, 0x24, 0x20, 0x20)
                )
            )
        }
    }

    /// @dev Sends `amount` of ERC20 `token` from `from` to `to`.
    /// If the initial attempt fails, try to use Permit2 to transfer the token.
    /// Reverts upon failure.
    ///
    /// The `from` account must have at least `amount` approved for the current contract to manage.
    function safeTransferFrom2(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal {
        if (!trySafeTransferFrom(token, from, to, amount)) {
            permit2TransferFrom(token, from, to, amount);
        }
    }

    /// @dev Sends `amount` of ERC20 `token` from `from` to `to` via Permit2.
    /// Reverts upon failure.
    function permit2TransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            mstore(add(m, 0x74), shr(96, shl(96, token)))
            mstore(add(m, 0x54), amount)
            mstore(add(m, 0x34), to)
            mstore(add(m, 0x20), shl(96, from))
            // `transferFrom(address,address,uint160,address)`.
            mstore(m, 0x36c78516000000000000000000000000)
            let p := PERMIT2
            let exists := eq(chainid(), 1)
            if iszero(exists) {
                exists := iszero(iszero(extcodesize(p)))
            }
            if iszero(
                and(
                    call(gas(), p, 0, add(m, 0x10), 0x84, codesize(), 0x00),
                    exists
                )
            ) {
                mstore(0x00, 0x7939f4248757f0fd) // `TransferFromFailed()` or `Permit2AmountOverflow()`.
                revert(
                    add(0x18, shl(2, iszero(iszero(shr(160, amount))))),
                    0x04
                )
            }
        }
    }

    /// @dev Permit a user to spend a given amount of
    /// another user's tokens via native EIP-2612 permit if possible, falling
    /// back to Permit2 if native permit fails or is not implemented on the token.
    function permit2(
        address token,
        address owner,
        address spender,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        bool success;
        /// @solidity memory-safe-assembly
        assembly {
            for {} shl(96, xor(token, WETH9)) {} {
                mstore(0x00, 0x3644e515) // `DOMAIN_SEPARATOR()`.
                if iszero(
                    and(
                        // The arguments of `and` are evaluated from right to left.
                        lt(iszero(mload(0x00)), eq(returndatasize(), 0x20)), // Returns 1 non-zero word.
                        // Gas stipend to limit gas burn for tokens that don't refund gas when
                        // an non-existing function is called. 5K should be enough for a SLOAD.
                        staticcall(5000, token, 0x1c, 0x04, 0x00, 0x20)
                    )
                ) {
                    break
                }
                // After here, we can be sure that token is a contract.
                let m := mload(0x40)
                mstore(add(m, 0x34), spender)
                mstore(add(m, 0x20), shl(96, owner))
                mstore(add(m, 0x74), deadline)
                if eq(mload(0x00), DAI_DOMAIN_SEPARATOR) {
                    mstore(0x14, owner)
                    mstore(0x00, 0x7ecebe00000000000000000000000000) // `nonces(address)`.
                    mstore(
                        add(m, 0x94),
                        staticcall(
                            gas(),
                            token,
                            0x10,
                            0x24,
                            add(m, 0x54),
                            0x20
                        )
                    )
                    mstore(m, 0x8fcbaf0c000000000000000000000000) // `IDAIPermit.permit`.
                    // `nonces` is already at `add(m, 0x54)`.
                    // `1` is already stored at `add(m, 0x94)`.
                    mstore(add(m, 0xb4), and(0xff, v))
                    mstore(add(m, 0xd4), r)
                    mstore(add(m, 0xf4), s)
                    success := call(
                        gas(),
                        token,
                        0,
                        add(m, 0x10),
                        0x104,
                        codesize(),
                        0x00
                    )
                    break
                }
                mstore(m, 0xd505accf000000000000000000000000) // `IERC20Permit.permit`.
                mstore(add(m, 0x54), amount)
                mstore(add(m, 0x94), and(0xff, v))
                mstore(add(m, 0xb4), r)
                mstore(add(m, 0xd4), s)
                success := call(
                    gas(),
                    token,
                    0,
                    add(m, 0x10),
                    0xe4,
                    codesize(),
                    0x00
                )
                break
            }
        }
        if (!success)
            simplePermit2(token, owner, spender, amount, deadline, v, r, s);
    }

    /// @dev Simple permit on the Permit2 contract.
    function simplePermit2(
        address token,
        address owner,
        address spender,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            mstore(m, 0x927da105) // `allowance(address,address,address)`.
            {
                let addressMask := shr(96, not(0))
                mstore(add(m, 0x20), and(addressMask, owner))
                mstore(add(m, 0x40), and(addressMask, token))
                mstore(add(m, 0x60), and(addressMask, spender))
                mstore(add(m, 0xc0), and(addressMask, spender))
            }
            let p := mul(PERMIT2, iszero(shr(160, amount)))
            if iszero(
                and(
                    // The arguments of `and` are evaluated from right to left.
                    gt(returndatasize(), 0x5f), // Returns 3 words: `amount`, `expiration`, `nonce`.
                    staticcall(
                        gas(),
                        p,
                        add(m, 0x1c),
                        0x64,
                        add(m, 0x60),
                        0x60
                    )
                )
            ) {
                mstore(0x00, 0x6b836e6b8757f0fd) // `Permit2Failed()` or `Permit2AmountOverflow()`.
                revert(add(0x18, shl(2, iszero(p))), 0x04)
            }
            mstore(m, 0x2b67b570) // `Permit2.permit` (PermitSingle variant).
            // `owner` is already `add(m, 0x20)`.
            // `token` is already at `add(m, 0x40)`.
            mstore(add(m, 0x60), amount)
            mstore(add(m, 0x80), 0xffffffffffff) // `expiration = type(uint48).max`.
            // `nonce` is already at `add(m, 0xa0)`.
            // `spender` is already at `add(m, 0xc0)`.
            mstore(add(m, 0xe0), deadline)
            mstore(add(m, 0x100), 0x100) // `signature` offset.
            mstore(add(m, 0x120), 0x41) // `signature` length.
            mstore(add(m, 0x140), r)
            mstore(add(m, 0x160), s)
            mstore(add(m, 0x180), shl(248, v))
            if iszero(
                call(gas(), p, 0, add(m, 0x1c), 0x184, codesize(), 0x00)
            ) {
                mstore(0x00, 0x6b836e6b) // `Permit2Failed()`.
                revert(0x1c, 0x04)
            }
        }
    }
}

// src/Libraries/LibUtil.sol

/// @custom:version 1.0.0

// solhint-disable-next-line no-global-import

library LibUtil {
    using LibBytes for bytes;

    function getRevertMsg(
        bytes memory _res
    ) internal pure returns (string memory) {
        // If the _res length is less than 68, then the transaction failed silently (without a revert message)
        if (_res.length < 68) return "Transaction reverted silently";
        bytes memory revertData = _res.slice(4, _res.length - 4); // Remove the selector which is the first 4 bytes
        return abi.decode(revertData, (string)); // All that remains is the revert string
    }

    /// @notice Determines whether the given address is the zero address
    /// @param addr The address to verify
    /// @return Boolean indicating if the address is the zero address
    function isZeroAddress(address addr) internal pure returns (bool) {
        return addr == address(0);
    }

    function revertWith(bytes memory data) internal pure {
        assembly {
            let dataSize := mload(data) // Load the size of the data
            let dataPtr := add(data, 0x20) // Advance data pointer to the next word
            revert(dataPtr, dataSize) // Revert with the given data
        }
    }
}

// src/Libraries/LibAsset.sol

/// @title LibAsset
/// @author LI.FI (https://li.fi)
/// @custom:version 2.1.3
/// @notice This library contains helpers for dealing with onchain transfers
///         of assets, including accounting for the native asset `assetId`
///         conventions and any noncompliant ERC20 transfers
library LibAsset {
    using SafeTransferLib for address;
    using SafeTransferLib for address payable;

    /// @dev All native assets use the empty address for their asset id
    ///      by convention
    address internal constant NULL_ADDRESS = address(0);

    /// @dev EIP-7702 delegation designator prefix for Account Abstraction
    bytes3 internal constant DELEGATION_DESIGNATOR = 0xef0100;

    /// @notice Gets the balance of the inheriting contract for the given asset
    /// @param assetId The asset identifier to get the balance of
    /// @return Balance held by contracts using this library (returns 0 if assetId does not exist)
    function getOwnBalance(address assetId) internal view returns (uint256) {
        return
            isNativeAsset(assetId)
                ? address(this).balance
                : assetId.balanceOf(address(this));
    }

    /// @notice Wrapper function to transfer a given asset (native or erc20) to
    ///         some recipient. Should handle all non-compliant return value
    ///         tokens as well by using the SafeERC20 contract by open zeppelin.
    /// @param assetId Asset id for transfer (address(0) for native asset,
    ///                token address for erc20s)
    /// @param recipient Address to send asset to
    /// @param amount Amount to send to given recipient
    function transferAsset(
        address assetId,
        address payable recipient,
        uint256 amount
    ) internal {
        if (isNativeAsset(assetId)) {
            transferNativeAsset(recipient, amount);
        } else {
            transferERC20(assetId, recipient, amount);
        }
    }

    /// @notice Transfers ether from the inheriting contract to a given
    ///         recipient
    /// @param recipient Address to send ether to
    /// @param amount Amount to send to given recipient
    function transferNativeAsset(
        address payable recipient,
        uint256 amount
    ) internal {
        // make sure a meaningful receiver address was provided
        if (recipient == NULL_ADDRESS) revert InvalidReceiver();

        // transfer native asset (will revert if target reverts or contract has insufficient balance)
        recipient.safeTransferETH(amount);
    }

    /// @notice Transfers tokens from the inheriting contract to a given recipient
    /// @param assetId Token address to transfer
    /// @param recipient Address to send tokens to
    /// @param amount Amount to send to given recipient
    function transferERC20(
        address assetId,
        address recipient,
        uint256 amount
    ) internal {
        // make sure a meaningful receiver address was provided
        if (recipient == NULL_ADDRESS) {
            revert InvalidReceiver();
        }

        // transfer ERC20 assets (will revert if target reverts or contract has insufficient balance)
        assetId.safeTransfer(recipient, amount);
    }

    /// @notice Transfers tokens from a sender to a given recipient
    /// @param assetId Token address to transfer
    /// @param from Address of sender/owner
    /// @param recipient Address of recipient/spender
    /// @param amount Amount to transfer from owner to spender
    function transferFromERC20(
        address assetId,
        address from,
        address recipient,
        uint256 amount
    ) internal {
        // check if native asset
        if (isNativeAsset(assetId)) {
            revert NullAddrIsNotAnERC20Token();
        }

        // make sure a meaningful receiver address was provided
        if (recipient == NULL_ADDRESS) {
            revert InvalidReceiver();
        }

        // transfer ERC20 assets (will revert if target reverts or contract has insufficient balance)
        assetId.safeTransferFrom(from, recipient, amount);
    }

    /// @notice Pulls tokens from msg.sender
    /// @param assetId Token address to transfer
    /// @param amount Amount to transfer from owner
    function depositAsset(address assetId, uint256 amount) internal {
        // make sure a meaningful amount was provided
        if (amount == 0) revert InvalidAmount();

        // check if native asset
        if (isNativeAsset(assetId)) {
            // ensure msg.value is equal or greater than amount
            if (msg.value < amount) revert InvalidAmount();
        } else {
            // transfer ERC20 assets (will revert if target reverts or contract has insufficient balance)
            assetId.safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function depositAssets(LibSwap.SwapData[] calldata swaps) internal {
        for (uint256 i = 0; i < swaps.length; ) {
            LibSwap.SwapData calldata swap = swaps[i];
            if (swap.requiresDeposit) {
                depositAsset(swap.sendingAssetId, swap.fromAmount);
            }
            unchecked {
                i++;
            }
        }
    }

    /// @notice If the current allowance is insufficient, the allowance for a given spender
    ///         is set to MAX_UINT.
    /// @param assetId Token address to transfer
    /// @param spender Address to give spend approval to
    /// @param amount allowance amount required for current transaction
    function maxApproveERC20(
        IERC20 assetId,
        address spender,
        uint256 amount
    ) internal {
        approveERC20(assetId, spender, amount, type(uint256).max);
    }

    /// @notice If the current allowance is insufficient, the allowance for a given spender
    ///         is set to the amount provided
    /// @param assetId Token address to transfer
    /// @param spender Address to give spend approval to
    /// @param requiredAllowance Allowance required for current transaction
    /// @param setAllowanceTo The amount the allowance should be set to if current allowance is insufficient
    function approveERC20(
        IERC20 assetId,
        address spender,
        uint256 requiredAllowance,
        uint256 setAllowanceTo
    ) internal {
        if (isNativeAsset(address(assetId))) {
            return;
        }

        // make sure a meaningful spender address was provided
        if (spender == NULL_ADDRESS) {
            revert NullAddrIsNotAValidSpender();
        }

        // check if allowance is sufficient, otherwise set allowance to provided amount
        // If the initial attempt to approve fails, attempts to reset the approved amount to zero,
        // then retries the approval again (some tokens, e.g. USDT, requires this).
        // Reverts upon failure
        if (assetId.allowance(address(this), spender) < requiredAllowance) {
            address(assetId).safeApproveWithRetry(spender, setAllowanceTo);
        }
    }

    /// @notice Determines whether the given assetId is the native asset
    /// @param assetId The asset identifier to evaluate
    /// @return Boolean indicating if the asset is the native asset
    function isNativeAsset(address assetId) internal pure returns (bool) {
        return assetId == NULL_ADDRESS;
    }

    /// @notice Checks if the given address is a contract
    ///         Returns true for any account with runtime code (excluding EIP-7702 accounts).
    ///         For EIP-7702 accounts, checks if code size is exactly 23 bytes (delegation format).
    ///         Limitations:
    ///         - Cannot distinguish between EOA and self-destructed contract
    /// @param account The address to be checked
    function isContract(address account) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }

        // Return true only for regular contracts (size > 23)
        // EIP-7702 delegated accounts (size == 23) are still EOAs, not contracts
        return size > 23;
    }
}

// src/Libraries/LibSwap.sol

/// @title LibSwap
/// @custom:version 1.1.0
/// @notice This library contains functionality to execute mostly swaps but also
///         other calls such as fee collection, token wrapping/unwrapping or
///         sending gas to destination chain
library LibSwap {
    /// @notice Struct containing all necessary data to execute a swap or generic call
    /// @param callTo The address of the contract to call for executing the swap
    /// @param approveTo The address that will receive token approval (can be different than callTo for some DEXs)
    /// @param sendingAssetId The address of the token being sent
    /// @param receivingAssetId The address of the token expected to be received
    /// @param fromAmount The exact amount of the sending asset to be used in the call
    /// @param callData Encoded function call data to be sent to the `callTo` contract
    /// @param requiresDeposit A flag indicating whether the tokens must be deposited (pulled) before the call
    struct SwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    /// @notice Emitted after a successful asset swap or related operation
    /// @param transactionId    The unique identifier associated with the swap operation
    /// @param dex              The address of the DEX or contract that handled the swap
    /// @param fromAssetId      The address of the token that was sent
    /// @param toAssetId        The address of the token that was received
    /// @param fromAmount       The amount of `fromAssetId` sent
    /// @param toAmount         The amount of `toAssetId` received
    /// @param timestamp        The timestamp when the swap was executed
    event AssetSwapped(
        bytes32 transactionId,
        address dex,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount,
        uint256 timestamp
    );

    function swap(bytes32 transactionId, SwapData calldata _swap) internal {
        // make sure callTo is a contract
        if (!LibAsset.isContract(_swap.callTo)) revert InvalidContract();

        // make sure that fromAmount is not 0
        uint256 fromAmount = _swap.fromAmount;
        if (fromAmount == 0) revert NoSwapFromZeroBalance();

        // determine how much native value to send with the swap call
        uint256 nativeValue = LibAsset.isNativeAsset(_swap.sendingAssetId)
            ? _swap.fromAmount
            : 0;

        // store initial balance (required for event emission)
        uint256 initialReceivingAssetBalance = LibAsset.getOwnBalance(
            _swap.receivingAssetId
        );

        // max approve (if ERC20)
        if (nativeValue == 0) {
            LibAsset.maxApproveERC20(
                IERC20(_swap.sendingAssetId),
                _swap.approveTo,
                _swap.fromAmount
            );
        }

        // we used to have a sending asset balance check here (initialSendingAssetBalance >= _swap.fromAmount)
        // this check was removed to allow for more flexibility with rebasing/fee-taking tokens
        // the general assumption is that if not enough tokens are available to execute the calldata,
        // the transaction will fail anyway
        // the error message might not be as explicit though

        // execute the swap
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory res) = _swap.callTo.call{
            value: nativeValue
        }(_swap.callData);
        if (!success) {
            LibUtil.revertWith(res);
        }

        // get post-swap balance
        uint256 newBalance = LibAsset.getOwnBalance(_swap.receivingAssetId);

        // emit event
        emit AssetSwapped(
            transactionId,
            _swap.callTo,
            _swap.sendingAssetId,
            _swap.receivingAssetId,
            _swap.fromAmount,
            newBalance > initialReceivingAssetBalance
                ? newBalance - initialReceivingAssetBalance
                : newBalance,
            block.timestamp
        );
    }
}

// src/Periphery/LDA/Facets/ContractBasedNativeWrapperFacet.sol

/// @title ContractBasedNativeWrapperFacet
/// @author LI.FI (https://li.fi)
/// @notice Handles wrapping/unwrapping of dual-purpose native tokens that function as both native and ERC-20
/// @dev Some blockchains implement native tokens with "token duality" - they function both as native currency
///      and as ERC-20 compatible tokens without requiring wrapping/unwrapping. Examples include:
///
///      CELO Token Duality (0x471EcE3750Da237f93B8E339c536989b8978a438):
///      - Functions as both native currency (like ETH) and ERC-20 token simultaneously
///      - Native transfers work like ETH transfers on Ethereum
///      - ERC-20 transfers use standard interface but trigger native transfers via precompile
///      - balanceOf() returns native balance directly (no separate storage)
///      - No deposit()/withdraw() methods needed - transfers are always native
///
///      This facet provides simple transfer-based operations for such tokens,
///      since they don't require actual wrapping/unwrapping operations.
/// @custom:version 1.0.0
contract ContractBasedNativeWrapperFacet is BaseRouteConstants {
    using LibPackedStream for uint256;

    // ==== External Functions ====

    /// @notice Unwraps dual-purpose native token
    /// @dev Dual-purpose native tokens (like CELO) don't have withdraw() methods since they're always native.
    ///      ERC-20 transfers automatically trigger native transfers via precompile, so we just transfer directly.
    /// @param swapData Encoded swap parameters [destinationAddress]
    /// @param from Token source. If from == msg.sender, pull tokens via transferFrom.
    ///             Otherwise, assume tokens are already held by this contract.
    /// @param tokenIn Dual-purpose native token address
    /// @param amountIn Amount of tokens to "unwrap" (actually just transfer natively)
    function unwrapContractBasedNative(
        bytes memory swapData,
        address from,
        address tokenIn,
        uint256 amountIn
    ) external payable {
        address destinationAddress;
        assembly {
            // swapData layout: [length (32 bytes)][data...]
            // We want the first 20 bytes of data, right-shifted to get address
            destinationAddress := shr(96, mload(add(swapData, 32)))
        }

        if (from == msg.sender) {
            LibAsset.transferFromERC20(
                tokenIn,
                msg.sender,
                address(this),
                amountIn
            );
        }

        // For dual-purpose native tokens, there's no "withdraw" - ERC-20 transfers automatically
        // trigger native transfers via precompile, so we just transfer the tokens directly
        if (destinationAddress != address(this)) {
            LibAsset.transferERC20(tokenIn, destinationAddress, amountIn);
        }
    }

    /// @notice Wraps native tokens to dual-purpose native token
    /// @dev Dual-purpose native tokens (like CELO) don't have deposit() methods since they're always native.
    ///      ERC-20 transfers automatically trigger native transfers via precompile, so we just transfer directly.
    /// @param swapData Encoded swap parameters [dualPurposeNativeToken, destinationAddress]
    /// @param amountIn Amount of native tokens to "wrap" (actually just transfer natively)
    function wrapContractBasedNative(
        bytes memory swapData,
        address, // from is not used
        address, // tokenIn is not used
        uint256 amountIn
    ) external payable {
        uint256 stream = LibPackedStream.createStream(swapData);

        address contractBasedNativeToken = stream.readAddress();
        address destinationAddress = stream.readAddress();

        if (contractBasedNativeToken == address(0)) {
            revert InvalidCallData();
        }

        // For contract-based native tokens, there's no "deposit" - we just transfer the tokens directly
        // since these tokens behave like native ETH but are actually ERC20 contracts
        if (destinationAddress != address(this)) {
            LibAsset.transferERC20(
                contractBasedNativeToken,
                destinationAddress,
                amountIn
            );
        }
    }
}
