/* solhint-disable */
// Sources flattened with hardhat v2.22.19 https://hardhat.org

// SPDX-License-Identifier: LGPL-3.0-only
// custom:version 1.0.0

// File contracts/libraries/Enum.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Enum - Collection of enums used in Safe Smart Account contracts.
 * @author @safe-global/safe-protocol
 */
library Enum {
    enum Operation {
        Call,
        DelegateCall
    }
}

// File contracts/base/Executor.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Executor - A contract that can execute transactions
 * @author Richard Meissner - @rmeissner
 */
abstract contract Executor {
    /**
     * @notice Executes either a delegatecall or a call with provided parameters.
     * @dev This method doesn't perform any sanity check of the transaction, such as:
     *      - if the contract at `to` address has code or not
     *      It is the responsibility of the caller to perform such checks.
     * @param to Destination address.
     * @param value Ether value.
     * @param data Data payload.
     * @param operation Operation type.
     * @return success boolean flag indicating if the call succeeded.
     */
    function execute(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256 txGas
    ) internal returns (bool success) {
        if (operation == Enum.Operation.DelegateCall) {
            /* solhint-disable no-inline-assembly */
            /// @solidity memory-safe-assembly
            assembly {
                success := delegatecall(
                    txGas,
                    to,
                    add(data, 0x20),
                    mload(data),
                    0,
                    0
                )
            }
            /* solhint-enable no-inline-assembly */
        } else {
            /* solhint-disable no-inline-assembly */
            /// @solidity memory-safe-assembly
            assembly {
                success := call(
                    txGas,
                    to,
                    value,
                    add(data, 0x20),
                    mload(data),
                    0,
                    0
                )
            }
            /* solhint-enable no-inline-assembly */
        }
    }
}

// File contracts/libraries/ErrorMessage.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only

pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Error Message - Contract which uses assembly to revert with a custom error message.
 * @author Shebin John - @remedcu
 * @notice The aim is to save gas using assembly to revert with a custom error message.
 */
abstract contract ErrorMessage {
    /**
     * @notice Function which uses assembly to revert with the passed error message.
     * @param error The error string to revert with.
     * @dev Currently it is expected that the `error` string is at max 5 bytes of length. Ex: "GSXXX"
     */
    function revertWithError(bytes5 error) internal pure {
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(
                ptr,
                0x08c379a000000000000000000000000000000000000000000000000000000000
            ) // Selector for method "Error(string)"
            mstore(add(ptr, 0x04), 0x20) // String offset
            mstore(add(ptr, 0x24), 0x05) // Revert reason length (5 bytes for bytes5)
            mstore(add(ptr, 0x44), error) // Revert reason
            revert(ptr, 0x64) // Revert data length is 4 bytes for selector + offset + error length + error.
        }
        /* solhint-enable no-inline-assembly */
    }
}

// File contracts/common/SelfAuthorized.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title SelfAuthorized - Authorizes current contract to perform actions to itself.
 * @author Richard Meissner - @rmeissner
 */
abstract contract SelfAuthorized is ErrorMessage {
    function requireSelfCall() private view {
        if (msg.sender != address(this)) revertWithError("GS031");
    }

    modifier authorized() {
        // Modifiers are copied around during compilation. This is a function call as it minimized the bytecode size
        requireSelfCall();
        _;
    }
}

// File contracts/interfaces/IFallbackManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title IFallbackManager - A contract interface managing fallback calls made to this contract.
 * @author @safe-global/safe-protocol
 */
interface IFallbackManager {
    event ChangedFallbackHandler(address indexed handler);

    /**
     * @notice Set Fallback Handler to `handler` for the Safe.
     * @dev 1. Only fallback calls without value and with data will be forwarded.
     *      2. Changing the fallback handler can only be done via a Safe transaction.
     *      3. Cannot be set to the Safe itself.
     *      4. IMPORTANT! SECURITY RISK! The fallback handler can be set to any address and all the calls will be forwarded to it,
     *         bypassing all the Safe's access control mechanisms. When setting the fallback handler, make sure to check the address
     *         is a trusted contract and if it supports state changes, it implements the necessary checks.
     * @param handler contract to handle fallback calls.
     */
    function setFallbackHandler(address handler) external;
}

// File contracts/base/FallbackManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Fallback Manager - A contract managing fallback calls made to this contract
 * @author Richard Meissner - @rmeissner
 */
abstract contract FallbackManager is SelfAuthorized, IFallbackManager {
    // keccak256("fallback_manager.handler.address")
    bytes32 internal constant FALLBACK_HANDLER_STORAGE_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    /**
     *  @notice Internal function to set the fallback handler.
     *  @param handler contract to handle fallback calls.
     */
    function internalSetFallbackHandler(address handler) internal {
        /*
            If a fallback handler is set to self, then the following attack vector is opened:
            Imagine we have a function like this:
            function withdraw() internal authorized {
                withdrawalAddress.call.value(address(this).balance)("");
            }

            If the fallback method is triggered, the fallback handler appends the msg.sender address to the calldata and calls the fallback handler.
            A potential attacker could call a Safe with the 3 bytes signature of a withdraw function. Since 3 bytes do not create a valid signature,
            the call would end in a fallback handler. Since it appends the msg.sender address to the calldata, the attacker could craft an address 
            where the first 3 bytes of the previous calldata + the first byte of the address make up a valid function signature. The subsequent call would result in unsanctioned access to Safe's internal protected methods.
            For some reason, solidity matches the first 4 bytes of the calldata to a function signature, regardless if more data follow these 4 bytes.
        */
        if (handler == address(this)) revertWithError("GS400");

        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            sstore(FALLBACK_HANDLER_STORAGE_SLOT, handler)
        }
        /* solhint-enable no-inline-assembly */
    }

    /**
     * @inheritdoc IFallbackManager
     */
    function setFallbackHandler(address handler) public override authorized {
        internalSetFallbackHandler(handler);
        emit ChangedFallbackHandler(handler);
    }

    // @notice Forwards all calls to the fallback handler if set. Returns 0 if no handler is set.
    // @dev Appends the non-padded caller address to the calldata to be optionally used in the handler
    //      The handler can make use of `HandlerContext.sol` to extract the address.
    //      This is done because in the next call frame the `msg.sender` will be FallbackManager's address
    //      and having the original caller address may enable additional verification scenarios.
    // solhint-disable-next-line payable-fallback,no-complex-fallback
    fallback() external {
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            // When compiled with the optimizer, the compiler relies on certain assumptions on how the
            // memory is used, therefore we need to guarantee memory safety (keeping the free memory point 0x40 slot intact,
            // not going beyond the scratch space, etc)
            // Solidity docs: https://docs.soliditylang.org/en/latest/assembly.html#memory-safety

            let handler := sload(FALLBACK_HANDLER_STORAGE_SLOT)

            if iszero(handler) {
                return(0, 0)
            }

            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())

            // The msg.sender address is shifted to the left by 12 bytes to remove the padding
            // Then the address without padding is stored right after the calldata
            mstore(add(ptr, calldatasize()), shl(96, caller()))

            // Add 20 bytes for the address appended at the end
            let success := call(
                gas(),
                handler,
                0,
                ptr,
                add(calldatasize(), 20),
                0,
                0
            )

            returndatacopy(ptr, 0, returndatasize())
            if iszero(success) {
                revert(ptr, returndatasize())
            }
            return(ptr, returndatasize())
        }
        /* solhint-enable no-inline-assembly */
    }
}

// File contracts/interfaces/IERC165.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/// @notice More details at https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/introspection/IERC165.sol
interface IERC165 {
    /**
     * @dev Returns true if this contract implements the interface defined by `interfaceId`.
     * See the corresponding EIP section
     * https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified
     * to learn more about how these ids are created.
     *
     * This function call must use less than 30 000 gas.
     */
    function supportsInterface(
        bytes4 interfaceId
    ) external view returns (bool);
}

// File contracts/interfaces/IGuardManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
/* solhint-disable one-contract-per-file */
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title IGuardManager - A contract interface managing transaction guards which perform pre and post-checks on Safe transactions.
 * @author @safe-global/safe-protocol
 */
interface IGuardManager {
    event ChangedGuard(address indexed guard);

    /**
     * @dev Set a guard that checks transactions before execution
     *      This can only be done via a Safe transaction.
     *      ⚠️ IMPORTANT: Since a guard has full power to block Safe transaction execution,
     *        a broken guard can cause a denial of service for the Safe. Make sure to carefully
     *        audit the guard code and design recovery mechanisms.
     * @notice Set Transaction Guard `guard` for the Safe. Make sure you trust the guard.
     * @param guard The address of the guard to be used or the 0 address to disable the guard
     */
    function setGuard(address guard) external;
}

// File contracts/base/GuardManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
/* solhint-disable one-contract-per-file */
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title ITransactionGuard Interface
 */
interface ITransactionGuard is IERC165 {
    /**
     * @notice Checks the transaction details.
     * @dev The function needs to implement transaction validation logic.
     * @param to The address to which the transaction is intended.
     * @param value The value of the transaction in Wei.
     * @param data The transaction data.
     * @param operation The type of operation of the transaction.
     * @param safeTxGas Gas used for the transaction.
     * @param baseGas The base gas for the transaction.
     * @param gasPrice The price of gas in Wei for the transaction.
     * @param gasToken The token used to pay for gas.
     * @param refundReceiver The address which should receive the refund.
     * @param signatures The signatures of the transaction.
     * @param msgSender The address of the message sender.
     */
    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures,
        address msgSender
    ) external;

    /**
     * @notice Checks after execution of the transaction.
     * @dev The function needs to implement a check after the execution of the transaction.
     * @param hash The hash of the transaction.
     * @param success The status of the transaction execution.
     */
    function checkAfterExecution(bytes32 hash, bool success) external;
}

abstract contract BaseTransactionGuard is ITransactionGuard {
    function supportsInterface(
        bytes4 interfaceId
    ) external view virtual override returns (bool) {
        return
            interfaceId == type(ITransactionGuard).interfaceId || // 0xe6d7a83a
            interfaceId == type(IERC165).interfaceId; // 0x01ffc9a7
    }
}

/**
 * @title Guard Manager - A contract managing transaction guards which perform pre and post-checks on Safe transactions.
 * @author Richard Meissner - @rmeissner
 */
abstract contract GuardManager is SelfAuthorized, IGuardManager {
    // keccak256("guard_manager.guard.address")
    bytes32 internal constant GUARD_STORAGE_SLOT =
        0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

    /**
     * @inheritdoc IGuardManager
     */
    function setGuard(address guard) external override authorized {
        if (
            guard != address(0) &&
            !ITransactionGuard(guard).supportsInterface(
                type(ITransactionGuard).interfaceId
            )
        ) revertWithError("GS300");
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            sstore(GUARD_STORAGE_SLOT, guard)
        }
        /* solhint-enable no-inline-assembly */
        emit ChangedGuard(guard);
    }

    /**
     * @dev Internal method to retrieve the current guard
     *      We do not have a public method because we're short on bytecode size limit,
     *      to retrieve the guard address, one can use `getStorageAt` from `StorageAccessible` contract
     *      with the slot `GUARD_STORAGE_SLOT`
     * @return guard The address of the guard
     */
    function getGuard() internal view returns (address guard) {
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            guard := sload(GUARD_STORAGE_SLOT)
        }
        /* solhint-enable no-inline-assembly */
    }
}

// File contracts/interfaces/IModuleManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title IModuleManager - An interface of contract managing Safe modules
 * @notice Modules are extensions with unlimited access to a Safe that can be added to a Safe by its owners.
           ⚠️ WARNING: Modules are a security risk since they can execute arbitrary transactions, 
           so only trusted and audited modules should be added to a Safe. A malicious module can
           completely takeover a Safe.
 * @author @safe-global/safe-protocol
 */
interface IModuleManager {
    event EnabledModule(address indexed module);
    event DisabledModule(address indexed module);
    event ExecutionFromModuleSuccess(address indexed module);
    event ExecutionFromModuleFailure(address indexed module);
    event ChangedModuleGuard(address indexed moduleGuard);

    /**
     * @notice Enables the module `module` for the Safe.
     * @dev This can only be done via a Safe transaction.
     * @param module Module to be whitelisted.
     */
    function enableModule(address module) external;

    /**
     * @notice Disables the module `module` for the Safe.
     * @dev This can only be done via a Safe transaction.
     * @param prevModule Previous module in the modules linked list.
     * @param module Module to be removed.
     */
    function disableModule(address prevModule, address module) external;

    /**
     * @notice Execute `operation` (0: Call, 1: DelegateCall) to `to` with `value` (Native Token)
     * @param to Destination address of module transaction.
     * @param value Ether value of module transaction.
     * @param data Data payload of module transaction.
     * @param operation Operation type of module transaction.
     * @return success Boolean flag indicating if the call succeeded.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external returns (bool success);

    /**
     * @notice Execute `operation` (0: Call, 1: DelegateCall) to `to` with `value` (Native Token) and return data
     * @param to Destination address of module transaction.
     * @param value Ether value of module transaction.
     * @param data Data payload of module transaction.
     * @param operation Operation type of module transaction.
     * @return success Boolean flag indicating if the call succeeded.
     * @return returnData Data returned by the call.
     */
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external returns (bool success, bytes memory returnData);

    /**
     * @notice Returns if a module is enabled
     * @return True if the module is enabled
     */
    function isModuleEnabled(address module) external view returns (bool);

    /**
     * @notice Returns an array of modules.
     *         If all entries fit into a single page, the next pointer will be 0x1.
     *         If another page is present, next will be the last element of the returned array.
     * @param start Start of the page. Has to be a module or start pointer (0x1 address)
     * @param pageSize Maximum number of modules that should be returned. Has to be > 0
     * @return array Array of modules.
     * @return next Start of the next page.
     */
    function getModulesPaginated(
        address start,
        uint256 pageSize
    ) external view returns (address[] memory array, address next);

    /**
     * @dev Set a module guard that checks transactions initiated by the module before execution
     *      This can only be done via a Safe transaction.
     *      ⚠️ IMPORTANT: Since a module guard has full power to block Safe transaction execution initiated via a module,
     *        a broken module guard can cause a denial of service for the Safe modules. Make sure to carefully
     *        audit the module guard code and design recovery mechanisms.
     * @notice Set Module Guard `moduleGuard` for the Safe. Make sure you trust the module guard.
     * @param moduleGuard The address of the module guard to be used or the zero address to disable the module guard.
     */
    function setModuleGuard(address moduleGuard) external;
}

// File contracts/base/ModuleManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
/* solhint-disable one-contract-per-file */
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title IModuleGuard Interface
 */
interface IModuleGuard is IERC165 {
    /**
     * @notice Checks the module transaction details.
     * @dev The function needs to implement module transaction validation logic.
     * @param to The address to which the transaction is intended.
     * @param value The value of the transaction in Wei.
     * @param data The transaction data.
     * @param operation The type of operation of the module transaction.
     * @param module The module involved in the transaction.
     * @return moduleTxHash The hash of the module transaction.
     */
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        address module
    ) external returns (bytes32 moduleTxHash);

    /**
     * @notice Checks after execution of module transaction.
     * @dev The function needs to implement a check after the execution of the module transaction.
     * @param txHash The hash of the module transaction.
     * @param success The status of the module transaction execution.
     */
    function checkAfterModuleExecution(bytes32 txHash, bool success) external;
}

abstract contract BaseModuleGuard is IModuleGuard {
    function supportsInterface(
        bytes4 interfaceId
    ) external view virtual override returns (bool) {
        return
            interfaceId == type(IModuleGuard).interfaceId || // 0x58401ed8
            interfaceId == type(IERC165).interfaceId; // 0x01ffc9a7
    }
}

/**
 * @title Module Manager - A contract managing Safe modules
 * @notice Modules are extensions with unlimited access to a Safe that can be added to a Safe by its owners.
           ⚠️ WARNING: Modules are a security risk since they can execute arbitrary transactions, 
           so only trusted and audited modules should be added to a Safe. A malicious module can
           completely takeover a Safe.
 * @author Stefan George - @Georgi87
 * @author Richard Meissner - @rmeissner
 */
abstract contract ModuleManager is SelfAuthorized, Executor, IModuleManager {
    // SENTINEL_MODULES is used to traverse `modules`, so that:
    //      1. `modules[SENTINEL_MODULES]` contains the first module
    //      2. `modules[last_module]` points back to SENTINEL_MODULES
    address internal constant SENTINEL_MODULES = address(0x1);

    // keccak256("module_manager.module_guard.address")
    bytes32 internal constant MODULE_GUARD_STORAGE_SLOT =
        0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;

    mapping(address => address) internal modules;

    /**
     * @notice Setup function sets the initial storage of the contract.
     *         Optionally executes a delegate call to another contract to setup the modules.
     * @param to Optional destination address of the call to execute.
     * @param data Optional data of call to execute.
     */
    function setupModules(address to, bytes memory data) internal {
        if (modules[SENTINEL_MODULES] != address(0)) revertWithError("GS100");
        modules[SENTINEL_MODULES] = SENTINEL_MODULES;
        if (to != address(0)) {
            if (!isContract(to)) revertWithError("GS002");
            // Setup has to complete successfully or the transaction fails.
            if (
                !execute(
                    to,
                    0,
                    data,
                    Enum.Operation.DelegateCall,
                    type(uint256).max
                )
            ) revertWithError("GS000");
        }
    }

    /**
     * @notice Runs pre-execution checks for module transactions if a guard is enabled.
     * @param to Target address of module transaction.
     * @param value Ether value of module transaction.
     * @param data Data payload of module transaction.
     * @param operation Operation type of module transaction.
     * @return guard Guard to be used for checking.
     * @return guardHash Hash returned from the guard tx check.
     */
    function preModuleExecution(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) internal returns (address guard, bytes32 guardHash) {
        onBeforeExecTransactionFromModule(to, value, data, operation);
        guard = getModuleGuard();

        // Only whitelisted modules are allowed.
        require(
            msg.sender != SENTINEL_MODULES &&
                modules[msg.sender] != address(0),
            "GS104"
        );

        if (guard != address(0)) {
            guardHash = IModuleGuard(guard).checkModuleTransaction(
                to,
                value,
                data,
                operation,
                msg.sender
            );
        }
    }

    /**
     * @notice Runs post-execution checks for module transactions if a guard is enabled.
     * @param guardHash Hash returned from the guard during pre execution check.
     * @param success Boolean flag indicating if the call succeeded.
     * @param guard Guard to be used for checking.
     * @dev Emits event based on module transaction success.
     */
    function postModuleExecution(
        address guard,
        bytes32 guardHash,
        bool success
    ) internal {
        if (guard != address(0)) {
            IModuleGuard(guard).checkAfterModuleExecution(guardHash, success);
        }
        if (success) emit ExecutionFromModuleSuccess(msg.sender);
        else emit ExecutionFromModuleFailure(msg.sender);
    }

    /**
     * @inheritdoc IModuleManager
     */
    function enableModule(address module) public override authorized {
        // Module address cannot be null or sentinel.
        if (module == address(0) || module == SENTINEL_MODULES)
            revertWithError("GS101");
        // Module cannot be added twice.
        if (modules[module] != address(0)) revertWithError("GS102");
        modules[module] = modules[SENTINEL_MODULES];
        modules[SENTINEL_MODULES] = module;
        emit EnabledModule(module);
    }

    /**
     * @inheritdoc IModuleManager
     */
    function disableModule(
        address prevModule,
        address module
    ) public override authorized {
        // Validate module address and check that it corresponds to module index.
        if (module == address(0) || module == SENTINEL_MODULES)
            revertWithError("GS101");
        if (modules[prevModule] != module) revertWithError("GS103");
        modules[prevModule] = modules[module];
        modules[module] = address(0);
        emit DisabledModule(module);
    }

    /**
     * @inheritdoc IModuleManager
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external override returns (bool success) {
        (address guard, bytes32 guardHash) = preModuleExecution(
            to,
            value,
            data,
            operation
        );
        success = execute(to, value, data, operation, type(uint256).max);
        postModuleExecution(guard, guardHash, success);
    }

    /**
     * @inheritdoc IModuleManager
     */
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) external override returns (bool success, bytes memory returnData) {
        (address guard, bytes32 guardHash) = preModuleExecution(
            to,
            value,
            data,
            operation
        );
        success = execute(to, value, data, operation, type(uint256).max);
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            // Load free memory location
            returnData := mload(0x40)
            // We allocate memory for the return data by setting the free memory location to
            // current free memory location + data size + 32 bytes for data size value
            mstore(0x40, add(returnData, add(returndatasize(), 0x20)))
            // Store the size
            mstore(returnData, returndatasize())
            // Store the data
            returndatacopy(add(returnData, 0x20), 0, returndatasize())
        }
        /* solhint-enable no-inline-assembly */
        postModuleExecution(guard, guardHash, success);
    }

    /**
     * @inheritdoc IModuleManager
     */
    function isModuleEnabled(
        address module
    ) public view override returns (bool) {
        return SENTINEL_MODULES != module && modules[module] != address(0);
    }

    /**
     * @inheritdoc IModuleManager
     */
    function getModulesPaginated(
        address start,
        uint256 pageSize
    ) external view override returns (address[] memory array, address next) {
        if (start != SENTINEL_MODULES && !isModuleEnabled(start))
            revertWithError("GS105");
        if (pageSize == 0) revertWithError("GS106");
        // Init array with max page size
        array = new address[](pageSize);

        // Populate return array
        uint256 moduleCount = 0;
        next = modules[start];
        while (
            next != address(0) &&
            next != SENTINEL_MODULES &&
            moduleCount < pageSize
        ) {
            array[moduleCount] = next;
            next = modules[next];
            ++moduleCount;
        }

        /**
          Because of the argument validation, we can assume that the loop will always iterate over the valid module list values
          and the `next` variable will either be an enabled module or a sentinel address (signalling the end). 
          
          If we haven't reached the end inside the loop, we need to set the next pointer to the last element of the modules array
          because the `next` variable (which is a module by itself) acting as a pointer to the start of the next page is neither 
          included to the current page, nor will it be included in the next one if you pass it as a start.
        */
        if (next != SENTINEL_MODULES) {
            next = array[moduleCount - 1];
        }
        // Set the correct size of the returned array
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            mstore(array, moduleCount)
        }
        /* solhint-enable no-inline-assembly */
    }

    /**
     * @notice Returns true if `account` is a contract.
     * @dev This function will return false if invoked during the constructor of a contract,
     *      as the code is not created until after the constructor finishes.
     * @param account The address being queried
     */
    function isContract(address account) internal view returns (bool) {
        uint256 size;
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            size := extcodesize(account)
        }
        /* solhint-enable no-inline-assembly */
        return size > 0;
    }

    /**
     * @inheritdoc IModuleManager
     */
    function setModuleGuard(address moduleGuard) external override authorized {
        if (
            moduleGuard != address(0) &&
            !IModuleGuard(moduleGuard).supportsInterface(
                type(IModuleGuard).interfaceId
            )
        ) revertWithError("GS301");

        bytes32 slot = MODULE_GUARD_STORAGE_SLOT;
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            sstore(slot, moduleGuard)
        }
        /* solhint-enable no-inline-assembly */
        emit ChangedModuleGuard(moduleGuard);
    }

    /**
     * @dev Internal method to retrieve the current module guard
     * @return moduleGuard The address of the guard
     */
    function getModuleGuard() internal view returns (address moduleGuard) {
        bytes32 slot = MODULE_GUARD_STORAGE_SLOT;
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            moduleGuard := sload(slot)
        }
        /* solhint-enable no-inline-assembly */
    }

    /**
     * @notice A hook that gets called before execution of {execTransactionFromModule*} methods.
     * @param to Destination address of module transaction.
     * @param value Ether value of module transaction.
     * @param data Data payload of module transaction.
     * @param operation Operation type of module transaction.
     */
    function onBeforeExecTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation
    ) internal virtual {}
}

// File contracts/interfaces/IOwnerManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title IOwnerManager - Interface for contract which manages Safe owners and a threshold to authorize transactions.
 * @author @safe-global/safe-protocol
 */
interface IOwnerManager {
    event AddedOwner(address indexed owner);
    event RemovedOwner(address indexed owner);
    event ChangedThreshold(uint256 threshold);

    /**
     * @notice Adds the owner `owner` to the Safe and updates the threshold to `_threshold`.
     * @dev This can only be done via a Safe transaction.
     * @param owner New owner address.
     * @param _threshold New threshold.
     */
    function addOwnerWithThreshold(address owner, uint256 _threshold) external;

    /**
     * @notice Removes the owner `owner` from the Safe and updates the threshold to `_threshold`.
     * @dev This can only be done via a Safe transaction.
     * @param prevOwner Owner that pointed to the owner to be removed in the linked list
     * @param owner Owner address to be removed.
     * @param _threshold New threshold.
     */
    function removeOwner(
        address prevOwner,
        address owner,
        uint256 _threshold
    ) external;

    /**
     * @notice Replaces the owner `oldOwner` in the Safe with `newOwner`.
     * @dev This can only be done via a Safe transaction.
     * @param prevOwner Owner that pointed to the owner to be replaced in the linked list
     * @param oldOwner Owner address to be replaced.
     * @param newOwner New owner address.
     */
    function swapOwner(
        address prevOwner,
        address oldOwner,
        address newOwner
    ) external;

    /**
     * @notice Changes the threshold of the Safe to `_threshold`.
     * @dev This can only be done via a Safe transaction.
     * @param _threshold New threshold.
     */
    function changeThreshold(uint256 _threshold) external;

    /**
     * @notice Returns the number of required confirmations for a Safe transaction aka the threshold.
     * @return Threshold number.
     */
    function getThreshold() external view returns (uint256);

    /**
     * @notice Returns if `owner` is an owner of the Safe.
     * @return Boolean if `owner` is an owner of the Safe.
     */
    function isOwner(address owner) external view returns (bool);

    /**
     * @notice Returns a list of Safe owners.
     * @return Array of Safe owners.
     */
    function getOwners() external view returns (address[] memory);
}

// File contracts/base/OwnerManager.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title OwnerManager - Manages Safe owners and a threshold to authorize transactions.
 * @dev Uses a linked list to store the owners because the code generated by the solidity compiler
 *      is more efficient than using a dynamic array.
 * @author Stefan George - @Georgi87
 * @author Richard Meissner - @rmeissner
 */
abstract contract OwnerManager is SelfAuthorized, IOwnerManager {
    // SENTINEL_OWNERS is used to traverse `owners`, so that:
    //      1. `owners[SENTINEL_OWNERS]` contains the first owner
    //      2. `owners[last_owner]` points back to SENTINEL_OWNERS
    address internal constant SENTINEL_OWNERS = address(0x1);

    mapping(address => address) internal owners;
    uint256 internal ownerCount;
    uint256 internal threshold;

    /**
     * @notice Sets the initial storage of the contract.
     * @param _owners List of Safe owners.
     * @param _threshold Number of required confirmations for a Safe transaction.
     */
    function setupOwners(
        address[] memory _owners,
        uint256 _threshold
    ) internal {
        // Threshold can only be 0 at initialization.
        // Check ensures that the setup function can only be called once.
        if (threshold > 0) revertWithError("GS200");
        // Validate that the threshold is smaller than the number of added owners.
        if (_threshold > _owners.length) revertWithError("GS201");
        // There has to be at least one Safe owner.
        if (_threshold == 0) revertWithError("GS202");
        // Initializing Safe owners.
        address currentOwner = SENTINEL_OWNERS;
        uint256 ownersLength = _owners.length;
        for (uint256 i = 0; i < ownersLength; ++i) {
            // Owner address cannot be null.
            address owner = _owners[i];
            if (
                owner == address(0) ||
                owner == SENTINEL_OWNERS ||
                owner == address(this) ||
                currentOwner == owner
            ) revertWithError("GS203");
            // No duplicate owners allowed.
            if (owners[owner] != address(0)) revertWithError("GS204");
            owners[currentOwner] = owner;
            currentOwner = owner;
        }
        owners[currentOwner] = SENTINEL_OWNERS;
        ownerCount = ownersLength;
        threshold = _threshold;
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function addOwnerWithThreshold(
        address owner,
        uint256 _threshold
    ) public override authorized {
        // Owner address cannot be null, the sentinel or the Safe itself.
        if (
            owner == address(0) ||
            owner == SENTINEL_OWNERS ||
            owner == address(this)
        ) revertWithError("GS203");
        // No duplicate owners allowed.
        if (owners[owner] != address(0)) revertWithError("GS204");
        owners[owner] = owners[SENTINEL_OWNERS];
        owners[SENTINEL_OWNERS] = owner;
        ++ownerCount;
        emit AddedOwner(owner);
        // Change threshold if threshold was changed.
        if (threshold != _threshold) changeThreshold(_threshold);
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function removeOwner(
        address prevOwner,
        address owner,
        uint256 _threshold
    ) public override authorized {
        // Only allow to remove an owner, if threshold can still be reached.
        // Here we do pre-decrement as it is cheaper and allows us to check if the threshold is still reachable.
        if (--ownerCount < _threshold) revertWithError("GS201");
        // Validate owner address and check that it corresponds to owner index.
        if (owner == address(0) || owner == SENTINEL_OWNERS)
            revertWithError("GS203");
        if (owners[prevOwner] != owner) revertWithError("GS205");
        owners[prevOwner] = owners[owner];
        owners[owner] = address(0);
        emit RemovedOwner(owner);
        // Change threshold if threshold was changed.
        if (threshold != _threshold) changeThreshold(_threshold);
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function swapOwner(
        address prevOwner,
        address oldOwner,
        address newOwner
    ) public override authorized {
        // Owner address cannot be null, the sentinel or the Safe itself.
        if (
            newOwner == address(0) ||
            newOwner == SENTINEL_OWNERS ||
            newOwner == address(this)
        ) revertWithError("GS203");
        // No duplicate owners allowed.
        if (owners[newOwner] != address(0)) revertWithError("GS204");
        // Validate oldOwner address and check that it corresponds to owner index.
        if (oldOwner == address(0) || oldOwner == SENTINEL_OWNERS)
            revertWithError("GS203");
        if (owners[prevOwner] != oldOwner) revertWithError("GS205");
        owners[newOwner] = owners[oldOwner];
        owners[prevOwner] = newOwner;
        owners[oldOwner] = address(0);
        emit RemovedOwner(oldOwner);
        emit AddedOwner(newOwner);
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function changeThreshold(uint256 _threshold) public override authorized {
        // Validate that threshold is smaller than number of owners.
        if (_threshold > ownerCount) revertWithError("GS201");
        // There has to be at least one Safe owner.
        if (_threshold == 0) revertWithError("GS202");
        threshold = _threshold;
        emit ChangedThreshold(_threshold);
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function getThreshold() public view override returns (uint256) {
        return threshold;
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function isOwner(address owner) public view override returns (bool) {
        return !(owner == SENTINEL_OWNERS || owners[owner] == address(0));
    }

    /**
     * @inheritdoc IOwnerManager
     */
    function getOwners() public view override returns (address[] memory) {
        address[] memory array = new address[](ownerCount);

        // populate return array
        uint256 index = 0;
        address currentOwner = owners[SENTINEL_OWNERS];
        while (currentOwner != SENTINEL_OWNERS) {
            array[index] = currentOwner;
            currentOwner = owners[currentOwner];
            ++index;
        }
        return array;
    }
}

// File contracts/interfaces/ISafe.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title ISafe - A multisignature wallet interface with support for confirmations using signed messages based on EIP-712.
 * @author @safe-global/safe-protocol
 */
interface ISafe is
    IModuleManager,
    IGuardManager,
    IOwnerManager,
    IFallbackManager
{
    event SafeSetup(
        address indexed initiator,
        address[] owners,
        uint256 threshold,
        address initializer,
        address fallbackHandler
    );
    event ApproveHash(bytes32 indexed approvedHash, address indexed owner);
    event SignMsg(bytes32 indexed msgHash);
    event ExecutionFailure(bytes32 indexed txHash, uint256 payment);
    event ExecutionSuccess(bytes32 indexed txHash, uint256 payment);

    /**
     * @notice Sets an initial storage of the Safe contract.
     * @dev This method can only be called once.
     *      If a proxy was created without setting up, anyone can call setup and claim the proxy.
     * @param _owners List of Safe owners.
     * @param _threshold Number of required confirmations for a Safe transaction.
     * @param to Contract address for optional delegate call.
     * @param data Data payload for optional delegate call.
     * @param fallbackHandler Handler for fallback calls to this contract
     * @param paymentToken Token that should be used for the payment (0 is ETH)
     * @param payment Value that should be paid
     * @param paymentReceiver Address that should receive the payment (or 0 if tx.origin)
     */
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    /** @notice Executes a `operation` {0: Call, 1: DelegateCall} transaction to `to` with `value` (Native Currency)
     *          and pays `gasPrice` * `gasLimit` in `gasToken` token to `refundReceiver`.
     * @dev The fees are always transferred, even if the user transaction fails.
     *      This method doesn't perform any sanity check of the transaction, such as:
     *      - if the contract at `to` address has code or not
     *      - if the `gasToken` is a contract or not
     *      It is the responsibility of the caller to perform such checks.
     * @param to Destination address of Safe transaction.
     * @param value Ether value of Safe transaction.
     * @param data Data payload of Safe transaction.
     * @param operation Operation type of Safe transaction.
     * @param safeTxGas Gas that should be used for the Safe transaction.
     * @param baseGas Gas costs that are independent of the transaction execution(e.g. base transaction fee, signature check, payment of the refund)
     * @param gasPrice Gas price that should be used for the payment calculation.
     * @param gasToken Token address (or 0 if ETH) that is used for the payment.
     * @param refundReceiver Address of receiver of gas payment (or 0 if tx.origin).
     * @param signatures Signature data that should be verified.
     *                   Can be packed ECDSA signature ({bytes32 r}{bytes32 s}{uint8 v}), contract signature (EIP-1271) or approved hash.
     * @return success Boolean indicating transaction's success.
     */
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    /**
     * @notice Checks whether the signature provided is valid for the provided data and hash and executor. Reverts otherwise.
     * @param executor Address that executes the transaction.
     *        ⚠️⚠️⚠️ Make sure that the executor address is a legitimate executor.
     *        Incorrectly passed the executor might reduce the threshold by 1 signature. ⚠️⚠️⚠️
     * @param dataHash Hash of the data (could be either a message hash or transaction hash)
     * @param signatures Signature data that should be verified.
     *                   Can be packed ECDSA signature ({bytes32 r}{bytes32 s}{uint8 v}), contract signature (EIP-1271) or approved hash.
     */
    function checkSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures
    ) external view;

    /**
     * @notice Checks whether the signature provided is valid for the provided data and hash. Reverts otherwise.
     * @dev Since the EIP-1271 does an external call, be mindful of reentrancy attacks.
     * @param executor Address that executes the transaction.
     *        ⚠️⚠️⚠️ Make sure that the executor address is a legitimate executor.
     *        Incorrectly passed the executor might reduce the threshold by 1 signature. ⚠️⚠️⚠️
     * @param dataHash Hash of the data (could be either a message hash or transaction hash)
     * @param signatures Signature data that should be verified.
     *                   Can be packed ECDSA signature ({bytes32 r}{bytes32 s}{uint8 v}), contract signature (EIP-1271) or approved hash.
     * @param requiredSignatures Amount of required valid signatures.
     */
    function checkNSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 requiredSignatures
    ) external view;

    /**
     * @notice Marks hash `hashToApprove` as approved.
     * @dev This can be used with a pre-approved hash transaction signature.
     *      IMPORTANT: The approved hash stays approved forever. There's no revocation mechanism, so it behaves similarly to ECDSA signatures
     * @param hashToApprove The hash to mark as approved for signatures that are verified by this contract.
     */
    function approveHash(bytes32 hashToApprove) external;

    /**
     * @dev Returns the domain separator for this contract, as defined in the EIP-712 standard.
     * @return bytes32 The domain separator hash.
     */
    function domainSeparator() external view returns (bytes32);

    /**
     * @notice Returns transaction hash to be signed by owners.
     * @param to Destination address.
     * @param value Ether value.
     * @param data Data payload.
     * @param operation Operation type.
     * @param safeTxGas Gas that should be used for the safe transaction.
     * @param baseGas Gas costs for data used to trigger the safe transaction.
     * @param gasPrice Maximum gas price that should be used for this transaction.
     * @param gasToken Token address (or 0 if ETH) that is used for the payment.
     * @param refundReceiver Address of receiver of gas payment (or 0 if tx.origin).
     * @param _nonce Transaction nonce.
     * @return Transaction hash.
     */
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) external view returns (bytes32);

    /**
     * External getter function for state variables.
     */

    /**
     * @notice Returns the version of the Safe contract.
     * @return Version string.
     */
    // solhint-disable-next-line
    function VERSION() external view returns (string memory);

    /**
     * @notice Returns the nonce of the Safe contract.
     * @return Nonce.
     */
    function nonce() external view returns (uint256);

    /**
     * @notice Returns a uint if the messageHash is signed by the owner.
     * @param messageHash Hash of message that should be checked.
     * @return Number denoting if an owner signed the hash.
     */
    function signedMessages(
        bytes32 messageHash
    ) external view returns (uint256);

    /**
     * @notice Returns a uint if the messageHash is approved by the owner.
     * @param owner Owner address that should be checked.
     * @param messageHash Hash of message that should be checked.
     * @return Number denoting if an owner approved the hash.
     */
    function approvedHashes(
        address owner,
        bytes32 messageHash
    ) external view returns (uint256);
}

// File contracts/common/NativeCurrencyPaymentFallback.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title NativeCurrencyPaymentFallback - A contract that has a fallback to accept native currency payments.
 * @author Richard Meissner - @rmeissner
 */
abstract contract NativeCurrencyPaymentFallback {
    event SafeReceived(address indexed sender, uint256 value);

    /**
     * @notice Receive function accepts native currency transactions.
     * @dev Emits an event with sender and received value.
     */
    receive() external payable {
        emit SafeReceived(msg.sender, msg.value);
    }
}

// File contracts/common/SecuredTokenTransfer.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title SecuredTokenTransfer - Secure token transfer.
 * @author Richard Meissner - @rmeissner
 */
abstract contract SecuredTokenTransfer {
    /**
     * @notice Transfers a token and returns a boolean if it was a success
     * @dev It checks the return data of the transfer call and returns true if the transfer was successful.
     *      It doesn't check if the `token` address is a contract or not.
     * @param token Token that should be transferred
     * @param receiver Receiver to whom the token should be transferred
     * @param amount The amount of tokens that should be transferred
     * @return transferred Returns true if the transfer was successful
     */
    function transferToken(
        address token,
        address receiver,
        uint256 amount
    ) internal returns (bool transferred) {
        // 0xa9059cbb - bytes4(keccak256("transfer(address,uint256)"))
        bytes memory data = abi.encodeWithSelector(
            0xa9059cbb,
            receiver,
            amount
        );
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            // We write the return value to scratch space.
            // See https://docs.soliditylang.org/en/v0.7.6/internals/layout_in_memory.html#layout-in-memory
            let success := call(
                sub(gas(), 10000),
                token,
                0,
                add(data, 0x20),
                mload(data),
                0,
                0x20
            )
            switch returndatasize()
            case 0 {
                transferred := success
            }
            case 0x20 {
                transferred := iszero(or(iszero(success), iszero(mload(0))))
            }
            default {
                transferred := 0
            }
        }
        /* solhint-enable no-inline-assembly */
    }
}

// File contracts/common/SignatureDecoder.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title SignatureDecoder - Decodes signatures encoded as bytes
 * @author Richard Meissner - @rmeissner
 */
abstract contract SignatureDecoder {
    /**
     * @notice Splits signature bytes into `uint8 v, bytes32 r, bytes32 s`.
     * @dev Make sure to perform a bounds check for @param pos, to avoid out of bounds access on @param signatures
     *      The signature format is a compact form of {bytes32 r}{bytes32 s}{uint8 v}
     *      Compact means uint8 is not padded to 32 bytes.
     * @param pos Which signature to read.
     *            A prior bounds check of this parameter should be performed, to avoid out of bounds access.
     * @param signatures Concatenated {r, s, v} signatures.
     * @return v Recovery ID or Safe signature type.
     * @return r Output value r of the signature.
     * @return s Output value s of the signature.
     */
    function signatureSplit(
        bytes memory signatures,
        uint256 pos
    ) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            let signaturePos := mul(0x41, pos)
            r := mload(add(signatures, add(signaturePos, 0x20)))
            s := mload(add(signatures, add(signaturePos, 0x40)))
            v := byte(0, mload(add(signatures, add(signaturePos, 0x60))))
        }
        /* solhint-enable no-inline-assembly */
    }
}

// File contracts/common/Singleton.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Singleton - Base for singleton contracts (should always be the first super contract)
 *        This contract is tightly coupled to our proxy contract (see `proxies/SafeProxy.sol`)
 * @author Richard Meissner - @rmeissner
 */
abstract contract Singleton {
    // singleton always has to be the first declared variable to ensure the same location as in the Proxy contract.
    // It should also always be ensured the address is stored alone (uses a full word)
    address private singleton;
}

// File contracts/common/StorageAccessible.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title StorageAccessible - A generic base contract that allows callers to access all internal storage.
 * @notice See https://github.com/gnosis/util-contracts/blob/bb5fe5fb5df6d8400998094fb1b32a178a47c3a1/contracts/StorageAccessible.sol
 *         It removes a method from the original contract not needed for the Safe Smart Account contracts.
 * @author Gnosis Developers
 */
abstract contract StorageAccessible {
    /**
     * @notice Reads `length` bytes of storage in the current contract
     * @param offset - the offset in the current contract's storage in words to start reading from
     * @param length - the number of words (32 bytes) of data to read
     * @return the bytes that were read.
     */
    function getStorageAt(
        uint256 offset,
        uint256 length
    ) public view returns (bytes memory) {
        // We use `<< 5` instead of `* 32` as SHR / SHL opcode only uses 3 gas, while DIV / MUL opcode uses 5 gas.
        bytes memory result = new bytes(length << 5);
        for (uint256 index = 0; index < length; ++index) {
            /* solhint-disable no-inline-assembly */
            /// @solidity memory-safe-assembly
            assembly {
                let word := sload(add(offset, index))
                mstore(add(add(result, 0x20), mul(index, 0x20)), word)
            }
            /* solhint-enable no-inline-assembly */
        }
        return result;
    }

    /**
     * @dev Performs a delegatecall on a targetContract in the context of self.
     * Internally reverts execution to avoid side effects (making it effectively static).
     *
     * This method reverts with data equal to `abi.encodePacked(uint256(success), uint256(response.length), bytes(response))`.
     * Specifically, the `returndata` after a call to this method will be:
     * `success:uint256 || response.length:uint256 || response:bytes`.
     *
     * @param targetContract Address of the contract containing the code to execute.
     * @param calldataPayload Calldata that should be sent to the target contract (encoded method name and arguments).
     */
    function simulateAndRevert(
        address targetContract,
        bytes memory calldataPayload
    ) external {
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            let success := delegatecall(
                gas(),
                targetContract,
                add(calldataPayload, 0x20),
                mload(calldataPayload),
                0,
                0
            )
            // Load free memory location
            let ptr := mload(0x40)
            mstore(ptr, success)
            mstore(add(ptr, 0x20), returndatasize())
            returndatacopy(add(ptr, 0x40), 0, returndatasize())
            revert(ptr, add(returndatasize(), 0x40))
        }
        /* solhint-enable no-inline-assembly */
    }
}

// File contracts/external/SafeMath.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title SafeMath
 * @notice Math operations with safety checks that revert on error (overflow/underflow)
 */
library SafeMath {
    /**
     * @notice Multiplies two numbers, reverts on overflow.
     * @param a First number
     * @param b Second number
     * @return Product of a and b
     */
    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        // Gas optimization: this is cheaper than requiring 'a' not to be zero, but the
        // benefit is lost if 'b' is also tested.
        // See: https://github.com/OpenZeppelin/openzeppelin-solidity/pull/522
        if (a == 0) {
            return 0;
        }

        uint256 c = a * b;
        require(c / a == b);

        return c;
    }

    /**
     * @notice Subtracts two numbers, reverts on overflow (i.e. if subtrahend is greater than minuend).
     * @param a First number
     * @param b Second number
     * @return Difference of a and b
     */
    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a);
        uint256 c = a - b;

        return c;
    }

    /**
     * @notice Adds two numbers, reverts on overflow.
     * @param a First number
     * @param b Second number
     * @return Sum of a and b
     */
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a);

        return c;
    }

    /**
     * @notice Returns the largest of two numbers.
     * @param a First number
     * @param b Second number
     * @return Largest of a and b
     */
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a : b;
    }
}

// File contracts/interfaces/ISignatureValidator.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
/* solhint-disable one-contract-per-file */
pragma solidity >=0.7.0 <0.9.0;

contract ISignatureValidatorConstants {
    // bytes4(keccak256("isValidSignature(bytes32,bytes)")
    bytes4 internal constant EIP1271_MAGIC_VALUE = 0x1626ba7e;
}

abstract contract ISignatureValidator is ISignatureValidatorConstants {
    /**
     * @notice EIP1271 method to validate a signature.
     * @param _hash Hash of the data signed on the behalf of address(this).
     * @param _signature Signature byte array associated with _data.
     *
     * MUST return the bytes4 magic value 0x1626ba7e when function passes.
     * MUST NOT modify state (using STATICCALL for solc < 0.5, view modifier for solc > 0.5)
     * MUST allow external calls
     */
    function isValidSignature(
        bytes32 _hash,
        bytes memory _signature
    ) external view virtual returns (bytes4);
}

// File contracts/Safe.sol

// Original license: SPDX_License_Identifier: LGPL-3.0-only
pragma solidity >=0.7.0 <0.9.0;

/**
 * @title Safe - A multisignature wallet with support for confirmations using signed messages based on EIP-712.
 * @dev Most important concepts:
 *      - Threshold: Number of required confirmations for a Safe transaction.
 *      - Owners: List of addresses that control the Safe. They are the only ones that can add/remove owners, change the threshold and
 *        approve transactions. Managed in `OwnerManager`.
 *      - Transaction Hash: Hash of a transaction is calculated using the EIP-712 typed structured data hashing scheme.
 *      - Nonce: Each transaction should have a different nonce to prevent replay attacks.
 *      - Signature: A valid signature of an owner of the Safe for a transaction hash.
 *      - Guards: Guards are contracts that can execute pre- and post- transaction checks. There are two types of guards:
 *          1. Transaction Guard: managed in `GuardManager` for transactions executed with `execTransaction`.
 *          2. Module Guard: managed in `ModuleManager` for transactions executed with `execTransactionFromModule`
 *      - Modules: Modules are contracts that can be used to extend the write functionality of a Safe. Managed in `ModuleManager`.
 *      - Fallback: Fallback handler is a contract that can provide additional functionality for Safe. Managed in `FallbackManager`. Please read the security risks in the `IFallbackManager` interface.
 *      Note: This version of the implementation contract doesn't emit events for the sake of gas efficiency and therefore requires a tracing node for indexing/
 *      For the events-based implementation see `SafeL2.sol`.
 * @author Stefan George - @Georgi87
 * @author Richard Meissner - @rmeissner
 */
contract Safe is
    Singleton,
    NativeCurrencyPaymentFallback,
    ModuleManager,
    GuardManager,
    OwnerManager,
    SignatureDecoder,
    SecuredTokenTransfer,
    ISignatureValidatorConstants,
    FallbackManager,
    StorageAccessible,
    ISafe
{
    using SafeMath for uint256;

    string public constant override VERSION = "1.5.0";

    // keccak256(
    //     "EIP712Domain(uint256 chainId,address verifyingContract)"
    // );
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH =
        0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;

    // keccak256(
    //     "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
    // );
    bytes32 private constant SAFE_TX_TYPEHASH =
        0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;

    uint256 public override nonce;
    bytes32 private _deprecatedDomainSeparator;
    // Mapping to keep track of all message hashes that have been approved by ALL REQUIRED owners
    mapping(bytes32 => uint256) public override signedMessages;
    // Mapping to keep track of all hashes (message or transaction) that have been approved by ANY owners
    mapping(address => mapping(bytes32 => uint256))
        public
        override approvedHashes;

    // This constructor ensures that this contract can only be used as a singleton for Proxy contracts
    constructor() {
        /**
         * By setting the threshold it is not possible to call setup anymore,
         * so we create a Safe with 0 owners and threshold 1.
         * This is an unusable Safe, perfect for the singleton
         */
        threshold = 1;
    }

    /**
     * @inheritdoc ISafe
     */
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external override {
        // setupOwners checks if the Threshold is already set, therefore preventing this method from being called more than once
        setupOwners(_owners, _threshold);
        if (fallbackHandler != address(0))
            internalSetFallbackHandler(fallbackHandler);
        // As setupOwners can only be called if the contract has not been initialized we don't need a check for setupModules
        setupModules(to, data);

        if (payment > 0) {
            // To avoid running into issues with EIP-170 we reuse the handlePayment function (to avoid adjusting code that has been verified we do not adjust the method itself)
            // baseGas = 0, gasPrice = 1 and gas = payment => amount = (payment + 0) * 1 = payment
            handlePayment(payment, 0, 1, paymentToken, paymentReceiver);
        }
        emit SafeSetup(msg.sender, _owners, _threshold, to, fallbackHandler);
    }

    /**
     * @inheritdoc ISafe
     */
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable override returns (bool success) {
        onBeforeExecTransaction(
            to,
            value,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            signatures
        );
        bytes32 txHash;
        // Use scope here to limit variable lifetime and prevent `stack too deep` errors
        {
            txHash = getTransactionHash( // Transaction info
                to,
                value,
                data,
                operation,
                safeTxGas,
                // Payment info
                baseGas,
                gasPrice,
                gasToken,
                refundReceiver,
                // Signature info
                // We use the post-increment here, so the current nonce value is used and incremented afterwards.
                nonce++
            );
            checkSignatures(msg.sender, txHash, signatures);
        }
        address guard = getGuard();
        {
            if (guard != address(0)) {
                ITransactionGuard(guard).checkTransaction(
                    // Transaction info
                    to,
                    value,
                    data,
                    operation,
                    safeTxGas,
                    // Payment info
                    baseGas,
                    gasPrice,
                    gasToken,
                    refundReceiver,
                    // Signature info
                    signatures,
                    msg.sender
                );
            }
        }

        // We require some gas to emit the events (at least 2500) after the execution and some to perform code until the execution (500)
        // We also include the 1/64 in the check that is not sent along with a call to counteract potential shortings because of EIP-150
        // We use `<< 6` instead of `* 64` as SHR / SHL opcode only uses 3 gas, while DIV / MUL opcode uses 5 gas.
        if (gasleft() < ((safeTxGas << 6) / 63).max(safeTxGas + 2500) + 500)
            revertWithError("GS010");
        // Use scope here to limit variable lifetime and prevent `stack too deep` errors
        {
            uint256 gasUsed = gasleft();
            // If the gasPrice is 0 we assume that nearly all available gas can be used (it is always more than safeTxGas)
            // We only subtract 2500 (compared to the 3000 before) to ensure that the amount passed is still higher than safeTxGas
            success = execute(
                to,
                value,
                data,
                operation,
                gasPrice == 0 ? (gasleft() - 2500) : safeTxGas
            );
            gasUsed = gasUsed.sub(gasleft());
            // If no safeTxGas and no gasPrice was set (e.g. both are 0), then the internal tx is required to be successful
            // This makes it possible to use `estimateGas` without issues, as it searches for the minimum gas where the tx doesn't revert
            if (!success && safeTxGas == 0 && gasPrice == 0) {
                /* solhint-disable no-inline-assembly */
                /// @solidity memory-safe-assembly
                assembly {
                    let ptr := mload(0x40)
                    returndatacopy(ptr, 0, returndatasize())
                    revert(ptr, returndatasize())
                }
                /* solhint-enable no-inline-assembly */
            }
            // We transfer the calculated tx costs to the tx.origin to avoid sending it to intermediate contracts that have made calls
            uint256 payment = 0;
            if (gasPrice > 0) {
                payment = handlePayment(
                    gasUsed,
                    baseGas,
                    gasPrice,
                    gasToken,
                    refundReceiver
                );
            }
            if (success) emit ExecutionSuccess(txHash, payment);
            else emit ExecutionFailure(txHash, payment);
        }
        {
            if (guard != address(0)) {
                ITransactionGuard(guard).checkAfterExecution(txHash, success);
            }
        }
    }

    /**
     * @notice Handles the payment for a Safe transaction.
     * @param gasUsed Gas used by the Safe transaction.
     * @param baseGas Gas costs that are independent of the transaction execution (e.g. base transaction fee, signature check, payment of the refund).
     * @param gasPrice Gas price that should be used for the payment calculation.
     * @param gasToken Token address (or 0 if ETH) that is used for the payment.
     * @return payment The amount of payment made in the specified token.
     */
    function handlePayment(
        uint256 gasUsed,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver
    ) private returns (uint256 payment) {
        // solhint-disable-next-line avoid-tx-origin
        address payable receiver = refundReceiver == address(0)
            ? payable(tx.origin)
            : refundReceiver;
        if (gasToken == address(0)) {
            // For native tokens, we will only adjust the gas price to not be higher than the actually used gas price
            payment = gasUsed.add(baseGas).mul(
                gasPrice < tx.gasprice ? gasPrice : tx.gasprice
            );
            (bool refundSuccess, ) = receiver.call{ value: payment }("");
            if (!refundSuccess) revertWithError("GS011");
        } else {
            payment = gasUsed.add(baseGas).mul(gasPrice);
            if (!transferToken(gasToken, receiver, payment))
                revertWithError("GS012");
        }
    }

    /**
     * @notice Checks whether the contract signature is valid. Reverts otherwise.
     * @dev This is extracted to a separate function for better compatibility with Certora's prover.
     *      More info here: https://github.com/safe-global/safe-smart-account/pull/661
     * @param owner Address of the owner used to sign the message
     * @param dataHash Hash of the data (could be either a message hash or transaction hash)
     * @param signatures Signature data that should be verified.
     * @param offset Offset to the start of the contract signature in the signatures byte array
     */
    function checkContractSignature(
        address owner,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 offset
    ) internal view {
        // Check that signature data pointer (s) is in bounds (points to the length of data -> 32 bytes)
        if (offset.add(32) > signatures.length) revertWithError("GS022");

        // Check if the contract signature is in bounds: start of data is s + 32 and end is start + signature length
        uint256 contractSignatureLen;
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            contractSignatureLen := mload(add(add(signatures, offset), 0x20))
        }
        /* solhint-enable no-inline-assembly */
        if (offset.add(32).add(contractSignatureLen) > signatures.length)
            revertWithError("GS023");

        // Check signature
        bytes memory contractSignature;
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            // The signature data for contract signatures is appended to the concatenated signatures and the offset is stored in s
            contractSignature := add(add(signatures, offset), 0x20)
        }
        /* solhint-enable no-inline-assembly */

        if (
            ISignatureValidator(owner).isValidSignature(
                dataHash,
                contractSignature
            ) != EIP1271_MAGIC_VALUE
        ) revertWithError("GS024");
    }

    /**
     * @inheritdoc ISafe
     */
    function checkSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures
    ) public view override {
        // Load threshold to avoid multiple storage loads
        uint256 _threshold = threshold;
        // Check that a threshold is set
        if (_threshold == 0) revertWithError("GS001");
        checkNSignatures(executor, dataHash, signatures, _threshold);
    }

    /**
     * @inheritdoc ISafe
     */
    function checkNSignatures(
        address executor,
        bytes32 dataHash,
        bytes memory signatures,
        uint256 requiredSignatures
    ) public view override {
        // Check that the provided signature data is not too short
        if (signatures.length < requiredSignatures.mul(65))
            revertWithError("GS020");
        // There cannot be an owner with address 0.
        address lastOwner = address(0);
        address currentOwner;
        uint256 v; // Implicit conversion from uint8 to uint256 will be done for v received from signatureSplit(...).
        bytes32 r;
        // NOTE: We do not enforce the `s` to be from the lower half of the curve
        // This essentially means that for every signature, there's another valid signature (known as ECDSA malleability)
        // Since we have other mechanisms to prevent duplicated signatures (ordered owners array) and replay protection (nonce),
        // we can safely ignore this malleability.
        bytes32 s;
        uint256 i;
        for (i = 0; i < requiredSignatures; ++i) {
            (v, r, s) = signatureSplit(signatures, i);
            if (v == 0) {
                // If v is 0 then it is a contract signature
                // When handling contract signatures the address of the contract is encoded into r
                currentOwner = address(uint160(uint256(r)));

                // Check that signature data pointer (s) is not pointing inside the static part of the signatures bytes
                // This check is not completely accurate, since it is possible that more signatures than the threshold are sent.
                // Here we only check that the pointer is not pointing inside the part that is being processed
                if (uint256(s) < requiredSignatures.mul(65))
                    revertWithError("GS021");

                // The contract signature check is extracted to a separate function for better compatibility with formal verification
                // A quote from the Certora team:
                // "The assembly code broke the pointer analysis, which switched the prover in failsafe mode, where it is (a) much slower and (b) computes different hashes than in the normal mode."
                // More info here: https://github.com/safe-global/safe-smart-account/pull/661
                checkContractSignature(
                    currentOwner,
                    dataHash,
                    signatures,
                    uint256(s)
                );
            } else if (v == 1) {
                // If v is 1 then it is an approved hash
                // When handling approved hashes the address of the approver is encoded into r
                currentOwner = address(uint160(uint256(r)));
                // Hashes are automatically approved by the sender of the message or when they have been pre-approved via a separate transaction
                if (
                    executor != currentOwner &&
                    approvedHashes[currentOwner][dataHash] == 0
                ) revertWithError("GS025");
            } else if (v > 30) {
                // If v > 30 then default va (27,28) has been adjusted for eth_sign flow
                // To support eth_sign and similar we adjust v and hash the messageHash with the Ethereum message prefix before applying ecrecover
                currentOwner = ecrecover(
                    keccak256(
                        abi.encodePacked(
                            "\x19Ethereum Signed Message:\n32",
                            dataHash
                        )
                    ),
                    uint8(v - 4),
                    r,
                    s
                );
            } else {
                // Default is the ecrecover flow with the provided data hash
                // Use ecrecover with the messageHash for EOA signatures
                currentOwner = ecrecover(dataHash, uint8(v), r, s);
            }
            if (
                currentOwner <= lastOwner ||
                owners[currentOwner] == address(0) ||
                currentOwner == SENTINEL_OWNERS
            ) revertWithError("GS026");
            lastOwner = currentOwner;
        }
    }

    /**
     * @notice Checks whether the signature provided is valid for the provided hash. Reverts otherwise.
     *         The `data` parameter is completely ignored during signature verification.
     * @dev This function is provided for compatibility with previous versions.
     *      Use `checkSignatures(address,bytes32,bytes)` instead.
     *      ⚠️⚠️⚠️ If the caller is an owner of the Safe, it can trivially sign any hash with a pre-approve signature and may reduce the threshold of the signature by 1. ⚠️⚠️⚠️
     * @param dataHash Hash of the data (could be either a message hash or transaction hash).
     * @param data **IGNORED** The data pre-image.
     * @param signatures Signature data that should be verified.
     *                   Can be packed ECDSA signature ({bytes32 r}{bytes32 s}{uint8 v}), contract signature (EIP-1271) or approved hash.
     */
    function checkSignatures(
        bytes32 dataHash,
        bytes calldata data,
        bytes memory signatures
    ) external view {
        data;
        checkSignatures(msg.sender, dataHash, signatures);
    }

    /**
     * @notice Checks whether the signature provided is valid for the provided hash. Reverts otherwise.
     *         The `data` parameter is completely ignored during signature verification.
     * @dev This function is provided for compatibility with previous versions.
     *      Use `checkNSignatures(address,bytes32,bytes,uint256)` instead.
     *      ⚠️⚠️⚠️ If the caller is an owner of the Safe, it can trivially sign any hash with a pre-approve signature and may reduce the threshold of the signature by 1. ⚠️⚠️⚠️
     * @param dataHash Hash of the data (could be either a message hash or transaction hash)
     * @param data **IGNORED** The data pre-image.
     * @param signatures Signature data that should be verified.
     *                   Can be packed ECDSA signature ({bytes32 r}{bytes32 s}{uint8 v}), contract signature (EIP-1271) or approved hash.
     * @param requiredSignatures Amount of required valid signatures.
     */
    function checkNSignatures(
        bytes32 dataHash,
        bytes calldata data,
        bytes memory signatures,
        uint256 requiredSignatures
    ) external view {
        data;
        checkNSignatures(msg.sender, dataHash, signatures, requiredSignatures);
    }

    /**
     * @inheritdoc ISafe
     */
    function approveHash(bytes32 hashToApprove) external override {
        if (owners[msg.sender] == address(0)) revertWithError("GS030");
        approvedHashes[msg.sender][hashToApprove] = 1;
        emit ApproveHash(hashToApprove, msg.sender);
    }

    /**
     * @inheritdoc ISafe
     */
    function domainSeparator() public view override returns (bytes32) {
        uint256 chainId;
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            chainId := chainid()
        }
        /* solhint-enable no-inline-assembly */

        return keccak256(abi.encode(DOMAIN_SEPARATOR_TYPEHASH, chainId, this));
    }

    /**
     * @inheritdoc ISafe
     */
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 _nonce
    ) public view override returns (bytes32 txHash) {
        bytes32 domainHash = domainSeparator();

        // We opted for using assembly code here, because the way Solidity compiler we use (0.7.6) allocates memory is
        // inefficient. We do not need to allocate memory for temporary variables to be used in the keccak256 call.
        //
        // WARNING: We do not clean potential dirty bits in types that are less than 256 bits (addresses and Enum.Operation)
        // The solidity assembly types that are smaller than 256 bit can have dirty high bits according to the spec (see the Warning in https://docs.soliditylang.org/en/latest/assembly.html#access-to-external-variables-functions-and-libraries).
        // However, we read most of the data from calldata, where the variables are not packed, and the only variable we read from storage is uint256 nonce.
        // This is not a problem, however, we must consider this for potential future changes.
        /* solhint-disable no-inline-assembly */
        /// @solidity memory-safe-assembly
        assembly {
            // Get the free memory pointer
            let ptr := mload(0x40)

            // Step 1: Hash the transaction data
            // Copy transaction data to memory and hash it
            calldatacopy(ptr, data.offset, data.length)
            let calldataHash := keccak256(ptr, data.length)

            // Step 2: Prepare the SafeTX struct for hashing
            // Layout in memory:
            // ptr +   0: SAFE_TX_TYPEHASH (constant defining the struct hash)
            // ptr +  32: to address
            // ptr +  64: value
            // ptr +  96: calldataHash
            // ptr + 128: operation
            // ptr + 160: safeTxGas
            // ptr + 192: baseGas
            // ptr + 224: gasPrice
            // ptr + 256: gasToken
            // ptr + 288: refundReceiver
            // ptr + 320: nonce
            mstore(ptr, SAFE_TX_TYPEHASH)
            mstore(add(ptr, 32), to)
            mstore(add(ptr, 64), value)
            mstore(add(ptr, 96), calldataHash)
            mstore(add(ptr, 128), operation)
            mstore(add(ptr, 160), safeTxGas)
            mstore(add(ptr, 192), baseGas)
            mstore(add(ptr, 224), gasPrice)
            mstore(add(ptr, 256), gasToken)
            mstore(add(ptr, 288), refundReceiver)
            mstore(add(ptr, 320), _nonce)

            // Step 3: Calculate the final EIP-712 hash
            // First, hash the SafeTX struct (352 bytes total length)
            mstore(add(ptr, 64), keccak256(ptr, 352))
            // Store the EIP-712 prefix (0x1901), note that integers are left-padded
            // so the EIP-712 encoded data starts at add(ptr, 30)
            mstore(ptr, 0x1901)
            // Store the domain separator
            mstore(add(ptr, 32), domainHash)
            // Calculate the hash
            txHash := keccak256(add(ptr, 30), 66)
        }
        /* solhint-enable no-inline-assembly */
    }

    /**
     * @notice A hook that gets called before execution of {execTransaction} method.
     * @param to Destination address of module transaction.
     * @param value Ether value of module transaction.
     * @param data Data payload of module transaction.
     * @param operation Operation type of module transaction.
     */
    function onBeforeExecTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        Enum.Operation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) internal virtual {}
}
