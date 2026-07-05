// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import { IVaultAccessControl } from "./interfaces/IVaultAccessControl.sol";
import { ISanctionsOracle } from "./interfaces/ISanctionsOracle.sol";
import { AccessConfig, ListBackend, ListGate } from "./LiFiVaultWrapperTypes.sol";

/// @title VaultWrapperAccessControl
/// @author LI.FI (https://li.fi)
/// @notice Deposit-path access control for a vault wrapper instance: an allow gate and a
///         deny gate (each independently backed by an on-chain mapping, a Merkle root —
///         allow gate only — or an external IVaultAccessControl adapter) plus an optional
///         sanctions-oracle hook. Checks validate the share receiver, never `msg.sender`,
///         so direct ERC-4626 calls and proxied (Composer) deposits are gated identically.
///         While any gate is active, shares are non-transferable; withdrawals are never
///         gated. All checks fail closed: a reverting or misconfigured backend blocks
///         deposits, not exits. This module holds no funds.
/// @dev Abstract module inherited by LiFiVaultWrapper; state lives in an ERC-7201
///      namespaced slot so inheriting it does not shift the wrapper's sequential storage
///      layout (the same convention OZ v5 upgradeable modules use). All mutators are
///      gated on the instance's `owner` — the integrator brings their own authority
///      model (EOA / multisig / timelock) by holding that role. The module deliberately
///      does not inherit OwnableUpgradeable (the wrapper's Ownable2Step branch would
///      diamond-clash on `transferOwnership`); the inheriting contract supplies the
///      owner check through the abstract `_requireAccessAdmin` seam instead.
/// @custom:version 1.0.0
abstract contract VaultWrapperAccessControl {
    /// Events ///

    /// @notice Emitted when a gate's storage backend is set (Disabled = gate off).
    /// @param gate The gate updated.
    /// @param backend The backend now serving the gate.
    event ListBackendSet(ListGate indexed gate, ListBackend backend);

    /// @notice Emitted per account added to or removed from a gate's on-chain mapping.
    /// @param gate The gate whose mapping changed.
    /// @param account The account added or removed.
    /// @param listed True if the account is now on the list.
    event ListUpdated(
        ListGate indexed gate,
        address indexed account,
        bool listed
    );

    /// @notice Emitted when the allow gate's Merkle root is set or rotated.
    /// @param root The new membership root.
    event AllowMerkleRootSet(bytes32 indexed root);

    /// @notice Emitted when the external access-control adapter is set.
    /// @param adapter The adapter serving External gates.
    event ExternalAdapterSet(address indexed adapter);

    /// @notice Emitted when the sanctions oracle is set (address(0) disables the hook).
    /// @param oracle The oracle screening receivers and transfer recipients.
    event SanctionsOracleSet(address indexed oracle);

    /// @notice Emitted when an account proves allow-gate membership under a root.
    /// @param root The Merkle root the proof verified against.
    /// @param account The account now cached as proven under that root.
    event AllowProven(bytes32 indexed root, address indexed account);

    /// Errors ///

    /// @notice Thrown when the share receiver fails the active allow gate.
    error ReceiverNotAllowed(address account);
    /// @notice Thrown when the share receiver is on the active deny gate's list.
    error ReceiverDenied(address account);
    /// @notice Thrown when the sanctions oracle reports an account as sanctioned.
    error AccountSanctioned(address account);
    /// @notice Thrown on share transfers while any access gate is active.
    error SharesNotTransferable();
    /// @notice Thrown when an access configuration is internally inconsistent (Merkle
    ///         deny gate, External gate without an adapter, Merkle gate without a root).
    error InvalidAccessConfig();
    /// @notice Thrown when a Merkle proof does not verify against the current root.
    error InvalidMerkleProof(address account);

    /// Storage ///

    /// @custom:storage-location erc7201:lifi.storage.VaultWrapperAccessControl
    struct AccessControlStorage {
        ListBackend allowBackend;
        ListBackend denyBackend;
        address externalAdapter;
        address sanctionsOracle;
        bytes32 allowMerkleRoot;
        mapping(address => bool) allowlisted;
        mapping(address => bool) denylisted;
        // Proven allow-gate membership, keyed by the root the proof verified against so
        // a root rotation invalidates every cached entry without iteration.
        mapping(bytes32 => mapping(address => bool)) provenAllowed;
    }

    /// @dev Gates a mutator on the instance's admin; the inheriting contract implements
    ///      `_requireAccessAdmin` (the wrapper forwards to OZ's `_checkOwner`).
    modifier onlyAccessAdmin() {
        _requireAccessAdmin();
        _;
    }

    /// @dev Reverts unless the caller is the instance's admin. Implemented by the
    ///      inheriting contract so this module stays decoupled from the ownership model.
    function _requireAccessAdmin() internal view virtual;

    /// @dev keccak256(abi.encode(uint256(keccak256("lifi.storage.VaultWrapperAccessControl")) - 1))
    ///      & ~bytes32(uint256(0xff)) per ERC-7201.
    bytes32 private constant ACCESS_CONTROL_STORAGE_LOCATION =
        0x3618cf1862ee8d06fdabca72ccfb8c798e32678dc37729ae2fad3a1c3da3b800;

    /// @dev Returns the module's namespaced storage struct. Assembly is the only way to
    ///      point a storage pointer at a fixed slot (the ERC-7201 accessor idiom OZ v5
    ///      modules use).
    function _getAccessControlStorage()
        private
        pure
        returns (AccessControlStorage storage $)
    {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := ACCESS_CONTROL_STORAGE_LOCATION
        }
    }

    /// Views ///

    /// @notice The instance's current access configuration (gates, adapter, oracle, root).
    /// @return config The configuration; all-defaults for a fully open instance.
    function accessConfig() public view returns (AccessConfig memory config) {
        AccessControlStorage storage $ = _getAccessControlStorage();
        config = AccessConfig({
            allowBackend: $.allowBackend,
            denyBackend: $.denyBackend,
            externalAdapter: $.externalAdapter,
            sanctionsOracle: $.sanctionsOracle,
            allowMerkleRoot: $.allowMerkleRoot
        });
    }

    /// @notice Whether an account is on a gate's on-chain mapping list.
    /// @param _gate The gate to query.
    /// @param _account The account to query.
    /// @return True if the account is on the gate's mapping list.
    function isListed(
        ListGate _gate,
        address _account
    ) public view returns (bool) {
        AccessControlStorage storage $ = _getAccessControlStorage();

        return
            _gate == ListGate.Allow
                ? $.allowlisted[_account]
                : $.denylisted[_account];
    }

    /// @notice Whether an account has proven allow-gate membership under the current root.
    /// @param _account The account to query.
    /// @return True if a valid proof was cached for the account under the current root.
    function isProvenAllowed(address _account) public view returns (bool) {
        AccessControlStorage storage $ = _getAccessControlStorage();

        return $.provenAllowed[$.allowMerkleRoot][_account];
    }

    /// @notice Whether wrapper shares are currently transferable. Any active gate makes
    ///         shares non-transferable so the deposit-path perimeter cannot be bypassed
    ///         by secondary transfer; the sanctions oracle alone does not freeze
    ///         transfers (recipients are screened instead).
    /// @return True if no access gate is active.
    function sharesTransferable() public view returns (bool) {
        AccessControlStorage storage $ = _getAccessControlStorage();

        return
            $.allowBackend == ListBackend.Disabled &&
            $.denyBackend == ListBackend.Disabled;
    }

    /// @notice Reverts with the specific denial reason if `_receiver` may not receive
    ///         freshly minted shares; returns silently otherwise. View mirror of the
    ///         deposit-path check for frontends and integrators (eth_call it).
    /// @param _receiver The prospective share receiver to validate.
    function checkDepositAccess(address _receiver) external view {
        _checkDepositAccess(_receiver);
    }

    /// @notice Whether `_receiver` currently passes the full deposit-path access check,
    ///         reported without reverting: a reverting backend reads as blocked, the
    ///         same fail-closed outcome the execution path enforces by reverting.
    /// @dev Feeds the EIP-4626 limit views (`maxDeposit`/`maxMint`), which MUST NOT
    ///      revert. The self-staticcall is the only way to catch the reverting check.
    /// @param _receiver The prospective share receiver to validate.
    /// @return True if a deposit minting to `_receiver` would pass the access check.
    function isDepositAllowed(address _receiver) public view returns (bool) {
        try this.checkDepositAccess(_receiver) {
            return true;
        } catch {
            return false;
        }
    }

    /// Mutators ///

    /// @notice Sets a gate's storage backend; `Disabled` switches the gate off. Enabling
    ///         any gate mechanically freezes share transfers (and disabling the last
    ///         active gate re-enables them) — transferability is coupled to access-mode
    ///         state, never a separate dial.
    /// @dev Only the owner may call. The gate's data source must already be consistent:
    ///      External requires a configured adapter, Merkle a non-zero root, and the deny
    ///      gate can never be Merkle (no non-inclusion proofs).
    /// @param _gate The gate to update.
    /// @param _backend The backend to serve the gate with.
    function setListBackend(
        ListGate _gate,
        ListBackend _backend
    ) external onlyAccessAdmin {
        _setListBackend(_gate, _backend);
    }

    /// @notice Adds or removes accounts on a gate's on-chain mapping list.
    /// @dev Only the owner may call. Entries are independent of the gate's active
    ///      backend, so a list can be seeded before the Mapping backend is enabled.
    /// @param _gate The gate whose mapping list to update.
    /// @param _accounts The accounts to add or remove.
    /// @param _listed True to add every account, false to remove.
    function updateList(
        ListGate _gate,
        address[] calldata _accounts,
        bool _listed
    ) external onlyAccessAdmin {
        AccessControlStorage storage $ = _getAccessControlStorage();
        mapping(address => bool) storage list = _gate == ListGate.Allow
            ? $.allowlisted
            : $.denylisted;
        for (uint256 i; i < _accounts.length; ++i) {
            list[_accounts[i]] = _listed;
            emit ListUpdated(_gate, _accounts[i], _listed);
        }
    }

    /// @notice Sets or rotates the allow gate's Merkle root. Rotation invalidates every
    ///         cached `proveAllowed` entry (the cache is keyed by root).
    /// @dev Only the owner may call. The root cannot be zeroed while the Merkle backend
    ///      is active — disable the gate first.
    /// @param _root The new membership root.
    function setAllowMerkleRoot(bytes32 _root) external onlyAccessAdmin {
        AccessControlStorage storage $ = _getAccessControlStorage();
        if (_root == bytes32(0) && $.allowBackend == ListBackend.Merkle)
            revert InvalidAccessConfig();
        $.allowMerkleRoot = _root;

        emit AllowMerkleRootSet(_root);
    }

    /// @notice Sets the external access-control adapter serving External gates.
    /// @dev Only the owner may call. The adapter cannot be zeroed while either gate is
    ///      on the External backend — switch the gates first.
    /// @param _adapter The IVaultAccessControl adapter.
    function setExternalAdapter(address _adapter) external onlyAccessAdmin {
        AccessControlStorage storage $ = _getAccessControlStorage();
        if (
            _adapter == address(0) &&
            ($.allowBackend == ListBackend.External ||
                $.denyBackend == ListBackend.External)
        ) revert InvalidAccessConfig();
        $.externalAdapter = _adapter;

        emit ExternalAdapterSet(_adapter);
    }

    /// @notice Sets the sanctions oracle; address(0) disables the hook.
    /// @dev Only the owner may call.
    /// @param _oracle The ISanctionsOracle to screen receivers and transfer recipients.
    function setSanctionsOracle(address _oracle) external onlyAccessAdmin {
        AccessControlStorage storage $ = _getAccessControlStorage();
        $.sanctionsOracle = _oracle;

        emit SanctionsOracleSet(_oracle);
    }

    /// @notice Permissionlessly proves an account's allow-gate membership under the
    ///         current Merkle root and caches the result, so anyone (the account, an
    ///         integrator backend, a Composer pre-step) can unlock deposits for a
    ///         receiver without touching the ERC-4626 call surface.
    /// @param _account The account whose membership the proof attests.
    /// @param _proof The Merkle proof for the account's double-hashed leaf.
    function proveAllowed(
        address _account,
        bytes32[] calldata _proof
    ) external {
        AccessControlStorage storage $ = _getAccessControlStorage();
        bytes32 root = $.allowMerkleRoot;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encode(_account)))
        );
        if (!MerkleProof.verifyCalldata(_proof, root, leaf))
            revert InvalidMerkleProof(_account);
        $.provenAllowed[root][_account] = true;

        emit AllowProven(root, _account);
    }

    /// Internal hooks ///

    /// @dev Decodes, validates, and stores the deploy-time AccessConfig. Empty bytes
    ///      configure a fully open instance. Emits the same events the setters would,
    ///      so indexers see the initial configuration without decoding calldata.
    function _initializeAccessControl(bytes memory _initData) internal {
        if (_initData.length == 0) return;

        AccessConfig memory config = abi.decode(_initData, (AccessConfig));
        AccessControlStorage storage $ = _getAccessControlStorage();
        $.externalAdapter = config.externalAdapter;
        $.sanctionsOracle = config.sanctionsOracle;
        $.allowMerkleRoot = config.allowMerkleRoot;

        if (config.allowBackend != ListBackend.Disabled)
            _setListBackend(ListGate.Allow, config.allowBackend);
        if (config.denyBackend != ListBackend.Disabled)
            _setListBackend(ListGate.Deny, config.denyBackend);

        if (config.externalAdapter != address(0))
            emit ExternalAdapterSet(config.externalAdapter);
        if (config.sanctionsOracle != address(0))
            emit SanctionsOracleSet(config.sanctionsOracle);
        if (config.allowMerkleRoot != bytes32(0))
            emit AllowMerkleRootSet(config.allowMerkleRoot);
    }

    /// @dev Deposit-path gate: validates the share receiver against the allow gate, the
    ///      deny gate, and the sanctions oracle, in that order. Fail-closed: a reverting
    ///      backend blocks the deposit (withdrawals never run this check).
    function _checkDepositAccess(address _receiver) internal view {
        AccessControlStorage storage $ = _getAccessControlStorage();

        ListBackend allowBackend = $.allowBackend;
        if (allowBackend != ListBackend.Disabled) {
            bool allowed;
            if (allowBackend == ListBackend.Mapping) {
                allowed = $.allowlisted[_receiver];
            } else if (allowBackend == ListBackend.Merkle) {
                allowed = $.provenAllowed[$.allowMerkleRoot][_receiver];
            } else {
                allowed = IVaultAccessControl($.externalAdapter).isAllowed(
                    _receiver
                );
            }
            if (!allowed) revert ReceiverNotAllowed(_receiver);
        }

        ListBackend denyBackend = $.denyBackend;
        if (denyBackend != ListBackend.Disabled) {
            bool denied = denyBackend == ListBackend.Mapping
                ? $.denylisted[_receiver]
                : IVaultAccessControl($.externalAdapter).isDenied(_receiver);
            if (denied) revert ReceiverDenied(_receiver);
        }

        _checkSanctions($, _receiver);
    }

    /// @dev Transfer-path gate: reverts while any gate is active (the perimeter must not
    ///      be bypassable by secondary transfer); otherwise screens the recipient through
    ///      the sanctions oracle when one is set. The sender is deliberately not
    ///      screened — blocking a holder's outbound movement is a custodial posture the
    ///      wrapper avoids, and exits are structurally open anyway.
    function _checkTransferAccess(address _to) internal view {
        AccessControlStorage storage $ = _getAccessControlStorage();
        if (
            $.allowBackend != ListBackend.Disabled ||
            $.denyBackend != ListBackend.Disabled
        ) revert SharesNotTransferable();

        _checkSanctions($, _to);
    }

    /// @dev Sets a gate's backend after validating it against the currently stored data
    ///      sources; shared by the owner setter and `_initializeAccessControl`.
    function _setListBackend(ListGate _gate, ListBackend _backend) private {
        AccessControlStorage storage $ = _getAccessControlStorage();
        if (
            _backend == ListBackend.External && $.externalAdapter == address(0)
        ) revert InvalidAccessConfig();
        if (_backend == ListBackend.Merkle) {
            if (_gate == ListGate.Deny || $.allowMerkleRoot == bytes32(0))
                revert InvalidAccessConfig();
        }

        if (_gate == ListGate.Allow) {
            $.allowBackend = _backend;
        } else {
            $.denyBackend = _backend;
        }

        emit ListBackendSet(_gate, _backend);
    }

    /// @dev Reverts if the sanctions oracle is set and reports the account as
    ///      sanctioned. Fail-closed: an oracle revert bubbles up.
    function _checkSanctions(
        AccessControlStorage storage $,
        address _account
    ) private view {
        address oracle = $.sanctionsOracle;
        if (
            oracle != address(0) &&
            ISanctionsOracle(oracle).isSanctioned(_account)
        ) revert AccountSanctioned(_account);
    }
}
