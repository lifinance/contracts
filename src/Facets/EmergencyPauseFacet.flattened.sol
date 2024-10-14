pragma solidity =0.8.17;

// src/Errors/GenericErrors.sol

/// @custom:version 1.0.0

error AlreadyInitialized();
error CannotAuthoriseSelf();
error CannotBridgeToSameNetwork();
error ContractCallNotAllowed();
error CumulativeSlippageTooHigh(uint256 minAmount, uint256 receivedAmount);
error DiamondIsPaused();
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
error UnAuthorized();
error UnsupportedChainId(uint256 chainId);
error WithdrawFailed();
error ZeroAmount();

// src/Interfaces/IDiamondCut.sol

/// @custom:version 1.0.0

interface IDiamondCut {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }
    // Add=0, Replace=1, Remove=2

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    /// @notice Add/replace/remove any number of functions and optionally execute
    ///         a function with delegatecall
    /// @param _diamondCut Contains the facet addresses and function selectors
    /// @param _init The address of the contract or facet to execute _calldata
    /// @param _calldata A function call, including function selector and arguments
    ///                  _calldata is executed with delegatecall on _init
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external;

    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);
}

// src/Interfaces/IDiamondLoupe.sol

/// @custom:version 1.0.0

// A loupe is a small magnifying glass used to look at diamonds.
// These functions look at diamonds
interface IDiamondLoupe {
    /// These functions are expected to be called frequently
    /// by tools.

    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }

    /// @notice Gets all facet addresses and their four byte function selectors.
    /// @return facets_ Facet
    function facets() external view returns (Facet[] memory facets_);

    /// @notice Gets all the function selectors supported by a specific facet.
    /// @param _facet The facet address.
    /// @return facetFunctionSelectors_
    function facetFunctionSelectors(
        address _facet
    ) external view returns (bytes4[] memory facetFunctionSelectors_);

    /// @notice Get all the facet addresses used by a diamond.
    /// @return facetAddresses_
    function facetAddresses()
        external
        view
        returns (address[] memory facetAddresses_);

    /// @notice Gets the facet that supports the given selector.
    /// @dev If facet is not found return address(0).
    /// @param _functionSelector The function selector.
    /// @return facetAddress_ The facet address.
    function facetAddress(
        bytes4 _functionSelector
    ) external view returns (address facetAddress_);
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
    /// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/8335676b0e99944eef6a742e16dcd9ff6e68e609/contracts/utils/Strings.sol
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
        require(value == 0, "Strings: hex length insufficient");
        return string(buffer);
    }
}

// src/Libraries/LibUtil.sol

/// @custom:version 1.0.0

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

// src/Libraries/LibDiamond.sol

/// @custom:version 1.0.0

/// Implementation of EIP-2535 Diamond Standard
/// https://eips.ethereum.org/EIPS/eip-2535
library LibDiamond {
    bytes32 internal constant DIAMOND_STORAGE_POSITION =
        keccak256("diamond.standard.diamond.storage");

    // Diamond specific errors
    error IncorrectFacetCutAction();
    error NoSelectorsInFace();
    error FunctionAlreadyExists();
    error FacetAddressIsZero();
    error FacetAddressIsNotZero();
    error FacetContainsNoCode();
    error FunctionDoesNotExist();
    error FunctionIsImmutable();
    error InitZeroButCalldataNotEmpty();
    error CalldataEmptyButInitNotZero();
    error InitReverted();
    // ----------------

    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition; // position in facetFunctionSelectors.functionSelectors array
    }

    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition; // position of facetAddress in facetAddresses array
    }

    struct DiamondStorage {
        // maps function selector to the facet address and
        // the position of the selector in the facetFunctionSelectors.selectors array
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacetAndPosition;
        // maps facet addresses to function selectors
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
        // facet addresses
        address[] facetAddresses;
        // Used to query if a contract implements an interface.
        // Used to implement ERC-165.
        mapping(bytes4 => bool) supportedInterfaces;
        // owner of the contract
        address contractOwner;
    }

    function diamondStorage()
        internal
        pure
        returns (DiamondStorage storage ds)
    {
        bytes32 position = DIAMOND_STORAGE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            ds.slot := position
        }
    }

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        address previousOwner = ds.contractOwner;
        ds.contractOwner = _newOwner;
        emit OwnershipTransferred(previousOwner, _newOwner);
    }

    function contractOwner() internal view returns (address contractOwner_) {
        contractOwner_ = diamondStorage().contractOwner;
    }

    function enforceIsContractOwner() internal view {
        if (msg.sender != diamondStorage().contractOwner)
            revert OnlyContractOwner();
    }

    event DiamondCut(
        IDiamondCut.FacetCut[] _diamondCut,
        address _init,
        bytes _calldata
    );

    // Internal function version of diamondCut
    function diamondCut(
        IDiamondCut.FacetCut[] memory _diamondCut,
        address _init,
        bytes memory _calldata
    ) internal {
        for (uint256 facetIndex; facetIndex < _diamondCut.length; ) {
            IDiamondCut.FacetCutAction action = _diamondCut[facetIndex].action;
            if (action == IDiamondCut.FacetCutAction.Add) {
                addFunctions(
                    _diamondCut[facetIndex].facetAddress,
                    _diamondCut[facetIndex].functionSelectors
                );
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                replaceFunctions(
                    _diamondCut[facetIndex].facetAddress,
                    _diamondCut[facetIndex].functionSelectors
                );
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                removeFunctions(
                    _diamondCut[facetIndex].facetAddress,
                    _diamondCut[facetIndex].functionSelectors
                );
            } else {
                revert IncorrectFacetCutAction();
            }
            unchecked {
                ++facetIndex;
            }
        }
        emit DiamondCut(_diamondCut, _init, _calldata);
        initializeDiamondCut(_init, _calldata);
    }

    function addFunctions(
        address _facetAddress,
        bytes4[] memory _functionSelectors
    ) internal {
        if (_functionSelectors.length == 0) {
            revert NoSelectorsInFace();
        }
        DiamondStorage storage ds = diamondStorage();
        if (LibUtil.isZeroAddress(_facetAddress)) {
            revert FacetAddressIsZero();
        }
        uint96 selectorPosition = uint96(
            ds.facetFunctionSelectors[_facetAddress].functionSelectors.length
        );
        // add new facet address if it does not exist
        if (selectorPosition == 0) {
            addFacet(ds, _facetAddress);
        }
        for (
            uint256 selectorIndex;
            selectorIndex < _functionSelectors.length;

        ) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds
                .selectorToFacetAndPosition[selector]
                .facetAddress;
            if (!LibUtil.isZeroAddress(oldFacetAddress)) {
                revert FunctionAlreadyExists();
            }
            addFunction(ds, selector, selectorPosition, _facetAddress);
            unchecked {
                ++selectorPosition;
                ++selectorIndex;
            }
        }
    }

    function replaceFunctions(
        address _facetAddress,
        bytes4[] memory _functionSelectors
    ) internal {
        if (_functionSelectors.length == 0) {
            revert NoSelectorsInFace();
        }
        DiamondStorage storage ds = diamondStorage();
        if (LibUtil.isZeroAddress(_facetAddress)) {
            revert FacetAddressIsZero();
        }
        uint96 selectorPosition = uint96(
            ds.facetFunctionSelectors[_facetAddress].functionSelectors.length
        );
        // add new facet address if it does not exist
        if (selectorPosition == 0) {
            addFacet(ds, _facetAddress);
        }
        for (
            uint256 selectorIndex;
            selectorIndex < _functionSelectors.length;

        ) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds
                .selectorToFacetAndPosition[selector]
                .facetAddress;
            if (oldFacetAddress == _facetAddress) {
                revert FunctionAlreadyExists();
            }
            removeFunction(ds, oldFacetAddress, selector);
            addFunction(ds, selector, selectorPosition, _facetAddress);
            unchecked {
                ++selectorPosition;
                ++selectorIndex;
            }
        }
    }

    function removeFunctions(
        address _facetAddress,
        bytes4[] memory _functionSelectors
    ) internal {
        if (_functionSelectors.length == 0) {
            revert NoSelectorsInFace();
        }
        DiamondStorage storage ds = diamondStorage();
        // if function does not exist then do nothing and return
        if (!LibUtil.isZeroAddress(_facetAddress)) {
            revert FacetAddressIsNotZero();
        }
        for (
            uint256 selectorIndex;
            selectorIndex < _functionSelectors.length;

        ) {
            bytes4 selector = _functionSelectors[selectorIndex];
            address oldFacetAddress = ds
                .selectorToFacetAndPosition[selector]
                .facetAddress;
            removeFunction(ds, oldFacetAddress, selector);
            unchecked {
                ++selectorIndex;
            }
        }
    }

    function addFacet(
        DiamondStorage storage ds,
        address _facetAddress
    ) internal {
        enforceHasContractCode(_facetAddress);
        ds.facetFunctionSelectors[_facetAddress].facetAddressPosition = ds
            .facetAddresses
            .length;
        ds.facetAddresses.push(_facetAddress);
    }

    function addFunction(
        DiamondStorage storage ds,
        bytes4 _selector,
        uint96 _selectorPosition,
        address _facetAddress
    ) internal {
        ds
            .selectorToFacetAndPosition[_selector]
            .functionSelectorPosition = _selectorPosition;
        ds.facetFunctionSelectors[_facetAddress].functionSelectors.push(
            _selector
        );
        ds.selectorToFacetAndPosition[_selector].facetAddress = _facetAddress;
    }

    function removeFunction(
        DiamondStorage storage ds,
        address _facetAddress,
        bytes4 _selector
    ) internal {
        if (LibUtil.isZeroAddress(_facetAddress)) {
            revert FunctionDoesNotExist();
        }
        // an immutable function is a function defined directly in a diamond
        if (_facetAddress == address(this)) {
            revert FunctionIsImmutable();
        }
        // replace selector with last selector, then delete last selector
        uint256 selectorPosition = ds
            .selectorToFacetAndPosition[_selector]
            .functionSelectorPosition;
        uint256 lastSelectorPosition = ds
            .facetFunctionSelectors[_facetAddress]
            .functionSelectors
            .length - 1;
        // if not the same then replace _selector with lastSelector
        if (selectorPosition != lastSelectorPosition) {
            bytes4 lastSelector = ds
                .facetFunctionSelectors[_facetAddress]
                .functionSelectors[lastSelectorPosition];
            ds.facetFunctionSelectors[_facetAddress].functionSelectors[
                selectorPosition
            ] = lastSelector;
            ds
                .selectorToFacetAndPosition[lastSelector]
                .functionSelectorPosition = uint96(selectorPosition);
        }
        // delete the last selector
        ds.facetFunctionSelectors[_facetAddress].functionSelectors.pop();
        delete ds.selectorToFacetAndPosition[_selector];

        // if no more selectors for facet address then delete the facet address
        if (lastSelectorPosition == 0) {
            // replace facet address with last facet address and delete last facet address
            uint256 lastFacetAddressPosition = ds.facetAddresses.length - 1;
            uint256 facetAddressPosition = ds
                .facetFunctionSelectors[_facetAddress]
                .facetAddressPosition;
            if (facetAddressPosition != lastFacetAddressPosition) {
                address lastFacetAddress = ds.facetAddresses[
                    lastFacetAddressPosition
                ];
                ds.facetAddresses[facetAddressPosition] = lastFacetAddress;
                ds
                    .facetFunctionSelectors[lastFacetAddress]
                    .facetAddressPosition = facetAddressPosition;
            }
            ds.facetAddresses.pop();
            delete ds
                .facetFunctionSelectors[_facetAddress]
                .facetAddressPosition;
        }
    }

    function initializeDiamondCut(
        address _init,
        bytes memory _calldata
    ) internal {
        if (LibUtil.isZeroAddress(_init)) {
            if (_calldata.length != 0) {
                revert InitZeroButCalldataNotEmpty();
            }
        } else {
            if (_calldata.length == 0) {
                revert CalldataEmptyButInitNotZero();
            }
            if (_init != address(this)) {
                enforceHasContractCode(_init);
            }
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, bytes memory error) = _init.delegatecall(_calldata);
            if (!success) {
                if (error.length > 0) {
                    // bubble up the error
                    revert(string(error));
                } else {
                    revert InitReverted();
                }
            }
        }
    }

    function enforceHasContractCode(address _contract) internal view {
        uint256 contractSize;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            contractSize := extcodesize(_contract)
        }
        if (contractSize == 0) {
            revert FacetContainsNoCode();
        }
    }
}

// src/Facets/DiamondCutFacet.sol

/// @title Diamond Cut Facet
/// @author LI.FI (https://li.fi)
/// @notice Core EIP-2535 Facet for upgrading Diamond Proxies.
/// @custom:version 1.0.0
contract DiamondCutFacet is IDiamondCut {
    /// @notice Add/replace/remove any number of functions and optionally execute
    ///         a function with delegatecall
    /// @param _diamondCut Contains the facet addresses and function selectors
    /// @param _init The address of the contract or facet to execute _calldata
    /// @param _calldata A function call, including function selector and arguments
    ///                  _calldata is executed with delegatecall on _init
    function diamondCut(
        FacetCut[] calldata _diamondCut,
        address _init,
        bytes calldata _calldata
    ) external override {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }
}

// src/Libraries/LibDiamondLoupe.sol

/// @custom:version 1.0.0

/// Library for DiamondLoupe functions (to avoid using external calls when using DiamondLoupe)
library LibDiamondLoupe {
    function facets()
        internal
        view
        returns (IDiamondLoupe.Facet[] memory facets_)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 numFacets = ds.facetAddresses.length;
        facets_ = new IDiamondLoupe.Facet[](numFacets);
        for (uint256 i = 0; i < numFacets; ) {
            address facetAddress_ = ds.facetAddresses[i];
            facets_[i].facetAddress = facetAddress_;
            facets_[i].functionSelectors = ds
                .facetFunctionSelectors[facetAddress_]
                .functionSelectors;
            unchecked {
                ++i;
            }
        }
    }

    function facetFunctionSelectors(
        address _facet
    ) internal view returns (bytes4[] memory facetFunctionSelectors_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetFunctionSelectors_ = ds
            .facetFunctionSelectors[_facet]
            .functionSelectors;
    }

    function facetAddresses()
        internal
        view
        returns (address[] memory facetAddresses_)
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddresses_ = ds.facetAddresses;
    }

    function facetAddress(
        bytes4 _functionSelector
    ) internal view returns (address facetAddress_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddress_ = ds
            .selectorToFacetAndPosition[_functionSelector]
            .facetAddress;
    }
}

// src/Facets/EmergencyPauseFacet.sol

/// @title EmergencyPauseFacet (Admin only)
/// @author LI.FI (https://li.fi)
/// @notice Allows a LI.FI-owned and -controlled, non-multisig "PauserWallet" to remove a facet or pause the diamond in case of emergency
/// @custom:version 1.0.0
/// @dev Admin-Facet for emergency purposes only
contract EmergencyPauseFacet {
    /// Events ///
    event EmergencyFacetRemoved(
        address indexed facetAddress,
        address indexed msgSender
    );
    event EmergencyPaused(address indexed msgSender);
    event EmergencyUnpaused(address indexed msgSender);

    /// Errors ///
    error FacetIsNotRegistered();
    error NoFacetToPause();

    /// Storage ///
    address public immutable pauserWallet;
    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.emergencyPauseFacet");
    address internal immutable _emergencyPauseFacetAddress;

    struct Storage {
        IDiamondLoupe.Facet[] facets;
    }

    /// Modifiers ///
    modifier OnlyPauserWalletOrOwner() {
        if (
            msg.sender != pauserWallet &&
            msg.sender != LibDiamond.contractOwner()
        ) revert UnAuthorized();
        _;
    }

    /// Constructor ///
    /// @param _pauserWallet The address of the wallet that can execute emergency facet removal actions
    constructor(address _pauserWallet) {
        pauserWallet = _pauserWallet;
        _emergencyPauseFacetAddress = address(this);
    }

    /// External Methods ///

    /// @notice Removes the given facet from the diamond
    /// @param _facetAddress The address of the facet that should be removed
    /// @dev can only be executed by pauserWallet (non-multisig for fast response time) or by the diamond owner
    function removeFacet(
        address _facetAddress
    ) external OnlyPauserWalletOrOwner {
        // make sure that the EmergencyPauseFacet itself cannot be removed through this function
        if (_facetAddress == _emergencyPauseFacetAddress)
            revert InvalidCallData();

        // get function selectors for this facet
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        bytes4[] memory functionSelectors = ds
            .facetFunctionSelectors[_facetAddress]
            .functionSelectors;

        // do not continue if no registered function selectors were found
        if (functionSelectors.length == 0) revert FacetIsNotRegistered();

        // make sure that DiamondCutFacet cannot be removed
        if (functionSelectors[0] == DiamondCutFacet.diamondCut.selector)
            revert InvalidCallData();

        // remove facet
        LibDiamond.removeFunctions(address(0), functionSelectors);

        emit EmergencyFacetRemoved(_facetAddress, msg.sender);
    }

    /// @notice Effectively pauses the diamond contract by overwriting the facetAddress-to-function-selector mappings in storage for all facets
    ///         and redirecting all function selectors to the EmergencyPauseFacet (this will remain as the only registered facet) so that
    ///         a meaningful error message will be returned when third parties try to call the diamond
    /// @dev can only be executed by pauserWallet (non-multisig for fast response time) or by the diamond owner
    /// @dev This function could potentially run out of gas if too many facets/function selectors are involved. We mitigate this issue by having a test on
    /// @dev forked mainnet (which has most facets) that checks if the diamond can be paused
    function pauseDiamond() external OnlyPauserWalletOrOwner {
        Storage storage s = getStorage();

        // get a list of all facets that need to be removed (=all facets except EmergencyPauseFacet)
        IDiamondLoupe.Facet[]
            memory facets = _getAllFacetFunctionSelectorsToBeRemoved();

        // prevent invalid contract state
        if (facets.length == 0) revert NoFacetToPause();

        // go through all facets
        for (uint256 i; i < facets.length; ) {
            // redirect all function selectors to this facet (i.e. to its fallback function with the DiamondIsPaused() error message)
            LibDiamond.replaceFunctions(
                _emergencyPauseFacetAddress,
                facets[i].functionSelectors
            );

            // write facet information to storage (so it can be easily reactivated later on)
            s.facets.push(facets[i]);

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        emit EmergencyPaused(msg.sender);
    }

    /// @notice Unpauses the diamond contract by re-adding all facetAddress-to-function-selector mappings to storage
    /// @dev can only be executed by diamond owner (multisig)
    /// @param _blacklist The address(es) of facet(s) that should not be reactivated
    function unpauseDiamond(address[] calldata _blacklist) external {
        // make sure this function can only be called by the owner
        LibDiamond.enforceIsContractOwner();

        // get all facets from storage
        Storage storage s = getStorage();

        // iterate through all facets and reinstate the facet with its function selectors
        for (uint256 i; i < s.facets.length; ) {
            LibDiamond.replaceFunctions(
                s.facets[i].facetAddress,
                s.facets[i].functionSelectors
            );

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        // go through blacklist and overwrite all function selectors with zero address
        // It would be easier to not reinstate these facets in the first place but
        //  a) that would leave their function selectors associated with address of EmergencyPauseFacet (=> throws 'DiamondIsPaused() error when called)
        //  b) it consumes a lot of gas to check every facet address if it's part of the blacklist
        bytes4[] memory currentSelectors;
        for (uint256 i; i < _blacklist.length; ) {
            currentSelectors = LibDiamondLoupe.facetFunctionSelectors(
                _blacklist[i]
            );

            // make sure that the DiamondCutFacet cannot be removed as this would make the diamond immutable
            if (currentSelectors[0] == DiamondCutFacet.diamondCut.selector)
                continue;

            // build FacetCut parameter
            IDiamondCut.FacetCut[]
                memory facetCut = new IDiamondCut.FacetCut[](1);
            facetCut[0] = IDiamondCut.FacetCut({
                facetAddress: address(0), // needs to be address(0) for removals
                action: IDiamondCut.FacetCutAction.Remove,
                functionSelectors: currentSelectors
            });

            // remove facet and its selectors from diamond
            LibDiamond.diamondCut(facetCut, address(0), "");

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }

        // free storage
        delete s.facets;

        emit EmergencyUnpaused(msg.sender);
    }

    /// INTERNAL HELPER FUNCTIONS

    function _getAllFacetFunctionSelectorsToBeRemoved()
        internal
        view
        returns (IDiamondLoupe.Facet[] memory toBeRemoved)
    {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory allFacets = LibDiamondLoupe.facets();

        // initiate return variable with allFacets length - 1 (since we will not remove the EmergencyPauseFacet)
        toBeRemoved = new IDiamondLoupe.Facet[](allFacets.length - 1);

        // iterate through facets, copy every facet but EmergencyPauseFacet
        uint256 toBeRemovedCounter;
        for (uint256 i; i < allFacets.length; ) {
            // if its not the EmergencyPauseFacet, copy to the return value variable
            if (allFacets[i].facetAddress != _emergencyPauseFacetAddress) {
                toBeRemoved[toBeRemovedCounter].facetAddress = allFacets[i]
                    .facetAddress;
                toBeRemoved[toBeRemovedCounter].functionSelectors = allFacets[
                    i
                ].functionSelectors;

                // gas-efficient way to increase counter
                unchecked {
                    ++toBeRemovedCounter;
                }
            }

            // gas-efficient way to increase loop counter
            unchecked {
                ++i;
            }
        }
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }

    // this function will be called when the diamond is paused to return a meaningful error message instead of "FunctionDoesNotExist"
    fallback() external payable {
        revert DiamondIsPaused();
    }

    // only added to silence compiler warnings that arose after adding the fallback function
    receive() external payable {}
}
