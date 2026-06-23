# S9 — Beacon + Upgrade Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between what PR #1936 (S8) already shipped and the S9 (EXSC-416) deliverables — namely the upgrade-path test coverage and a standalone beacon deploy + impl-registration script — without re-implementing the beacon mechanics that already work.

**Architecture:** The beacon already exists as OZ `UpgradeableBeacon` and clones are Solady `LibClone` ERC-1967 beacon proxies that re-read the impl every call (`LiFiVaultWrapperFactory.deploy`). The mechanism is live; what's missing is (a) tests proving clones delegate to the current impl and that a `beacon.upgradeTo` propagates to every existing clone and is owner-gated, and (b) a standalone beacon-deploy/impl-registration forge `Script` so the beacon can be deployed and re-pointed as a governance operation. The beacon's owner is wired to the governance `owner` here; gating that owner behind the dedicated 48h timelock is **S10 (EXSC-418)**, not this ticket.

**Tech Stack:** Solidity ^0.8.17 · Foundry (`forge test`, forge `Script`) · OZ `UpgradeableBeacon` (v4.9.0) · Solady `LibClone` ERC-1967 beacon proxies.

---

## Scope decisions (read before starting)

1. **No custom beacon contract.** S9's "Beacon contract" line is satisfied by OZ `UpgradeableBeacon`, which is the locked design decision and is what S8 already deploys. We do **not** introduce a `LiFiVaultBeacon`. (Open consideration, deferred: OZ `UpgradeableBeacon` uses single-step `Ownable` with a `renounceOwnership` footgun, unlike the repo's two-step `TransferrableOwnership`. Flag for S10/governance review; not in scope here.)
2. **Upgrade gating authority.** S9 proves `upgradeTo` is **owner-gated** and that ownership sits with governance. Binding that owner to the **48h timelock** is S10. Tests here assert "only the beacon owner can upgrade", using a plain governance `owner` EOA as the stand-in for the eventual timelock.
3. **Standalone script vs S8's inlined beacon deploy.** S8's `DeployLiFiVaultWrapperFactory.s.sol` deploys the beacon inline. S9 adds a **separate** `DeployVaultWrapperBeacon.s.sol` (deploy beacon + transfer ownership to governance) and a `RegisterVaultWrapperImpl.s.sol` (governance-driven `upgradeTo`). We do **not** refactor the S8 combined script in this PR — that churns the open #1936 diff. The standalone scripts are what S14 (EXSC-420) will fold into the full `DeployScriptBase`/CREATE3 flow; here they are functional bootstraps mirroring the style of the existing `DeployLiFiVaultWrapperFactory.s.sol` (plain `forge-std/Script`, env-driven).
4. **Branch / PR.** Work lands on `feature/exsc-416-s9-beacon-upgrade-wiring`, stacked on `feature/exsc-417-s8-factory` (PR #1936). The S9 PR bases on `feature/exsc-417-s8-factory`; retarget to `dev-vault-wrapper` after #1936 merges. Run `/pr-ready` with `--base feature/exsc-417-s8-factory`.

## File Structure

| File | Responsibility | Create / Modify |
|---|---|---|
| `test/solidity/VaultWrapper/mocks/MockVaultWrapperV2.sol` | A 5-line second beacon impl that **inherits** `MockVaultWrapper` (identical storage + interface) and adds a `version()` marker, so an upgrade is observable through every clone. | Create |
| `test/solidity/VaultWrapper/BeaconUpgrade.t.sol` | Integration tests for the beacon upgrade path: clones delegate to current impl; `upgradeTo` propagates to all existing clones; only the owner can upgrade; upgrade to a non-contract reverts. | Create |
| `script/deploy/facets/DeployVaultWrapperBeacon.s.sol` | Standalone beacon deploy: deploy `MockVaultWrapper` impl, `UpgradeableBeacon(impl)`, transfer beacon ownership to governance `OWNER`. Env-driven, mirrors `DeployLiFiVaultWrapperFactory.s.sol`. | Create |
| `script/deploy/facets/RegisterVaultWrapperImpl.s.sol` | Governance-driven impl registration: `UpgradeableBeacon(BEACON).upgradeTo(NEW_IMPL)`. The impl-registration entrypoint S9 calls for. | Create |

No `src/` changes. The factory and beacon mechanics are unchanged — this PR is tests + scripts only.

---

## Task 1: Second mock impl that makes an upgrade observable

**Files:**

- Create: `test/solidity/VaultWrapper/mocks/MockVaultWrapperV2.sol`

The existing `MockVaultWrapper` (`src/VaultWrapper/mocks/MockVaultWrapper.sol`) is the V1 impl. To prove an upgrade propagated to existing clones we need a *second* impl with an observable behavioral delta — a second instance of the same contract would be indistinguishable. The minimal form is a contract that **inherits** `MockVaultWrapper` (so storage layout and the full `initialize`/`asset`/`name` interface are identical and reused, not copy-pasted) and adds one new selector, `version()`. On a V1-backed clone, `version()` reverts (no such selector); after the beacon is upgraded to this impl, every existing clone returns `2`. That single selector is the propagation proof.

Note: `MockVaultWrapper`'s `name()`/`symbol()` are not `virtual`, so V2 cannot override them — and it doesn't need to. The added `version()` is the entire delta; do not re-declare storage or `initialize`.

- [ ] **Step 1: Write the V2 mock**

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";

/// @title MockVaultWrapperV2
/// @author LI.FI (https://li.fi)
/// @notice Upgrade target used only by BeaconUpgrade.t.sol to prove a beacon
///         upgrade propagates to every existing clone. Inherits MockVaultWrapper
///         (identical storage + initialize/asset interface) and adds a version()
///         marker absent from V1, so the swap is observable through clones.
contract MockVaultWrapperV2 is MockVaultWrapper {
    function version() external pure returns (uint256) {
        return 2;
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `forge build`
Expected: compiles with no errors (the file is only referenced by tests next task, so a bare build confirms the contract is well-formed).

- [ ] **Step 3: Commit**

```bash
git add test/solidity/VaultWrapper/mocks/MockVaultWrapperV2.sol
git commit -m "test(EXSC-416): add MockVaultWrapperV2 upgrade target"
```

---

## Task 2: Test — clones delegate to the current impl

**Files:**

- Create: `test/solidity/VaultWrapper/BeaconUpgrade.t.sol`

Proves story A1/A4 baseline: a freshly deployed clone reflects the beacon's current implementation. We deploy a clone via the factory and assert it reports `MockVaultWrapper`'s `name()`. This `setUp` is reused by every later task in this file.

- [ ] **Step 1: Write the test file with setUp + the first test**

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { LiFiVaultWrapperFactory } from "lifi/VaultWrapper/LiFiVaultWrapperFactory.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";
import { MockVaultWrapperV2 } from "./mocks/MockVaultWrapperV2.sol";
import { ERC4626Adapter } from "lifi/VaultWrapper/adapters/ERC4626Adapter.sol";
import { MockERC4626Underlying } from "./mocks/MockERC4626Underlying.sol";
import { DeployParams, FeeConfig, FeeType } from "lifi/VaultWrapper/LiFiVaultWrapperTypes.sol";

contract BeaconUpgradeTest is Test {
    LiFiVaultWrapperFactory internal factory;
    UpgradeableBeacon internal beacon;
    MockVaultWrapper internal implV1;
    MockVaultWrapperV2 internal implV2;
    ERC4626Adapter internal adapter;
    MockERC4626Underlying internal underlying;

    address internal owner = makeAddr("owner");
    address internal pauser = makeAddr("pauser");
    address internal onboarder = makeAddr("onboarder");
    address internal lifiRecipient = makeAddr("lifiRecipient");
    address internal vaultAdmin = makeAddr("vaultAdmin");
    address internal assetToken = makeAddr("asset");
    bytes32 internal constant NS = bytes32("Coinbase");

    function setUp() public {
        implV1 = new MockVaultWrapper();
        implV2 = new MockVaultWrapperV2();
        beacon = new UpgradeableBeacon(address(implV1));
        beacon.transferOwnership(owner);
        factory = new LiFiVaultWrapperFactory(
            address(beacon),
            owner,
            pauser,
            onboarder,
            lifiRecipient
        );
        adapter = new ERC4626Adapter();
        underlying = new MockERC4626Underlying(assetToken);
        vm.startPrank(owner);
        factory.setAdapterApproved(address(adapter), true);
        factory.setUnderlyingAllowed(address(underlying), true);
        vm.stopPrank();
    }

    function _deployClone(uint256 nonce_) internal returns (address) {
        FeeConfig memory fees;
        DeployParams memory params = DeployParams({
            namespace: NS,
            vaultWrapperAdmin: vaultAdmin,
            adapter: address(adapter),
            underlying: address(underlying),
            nonce: nonce_,
            fees: fees,
            integratorShareBps: type(uint16).max,
            initData: ""
        });
        vm.prank(onboarder);
        return factory.deploy(params);
    }

    function test_CloneDelegatesToCurrentImpl() public {
        address clone = _deployClone(0);
        assertEq(MockVaultWrapper(clone).name(), "Mock Vault Wrapper");
        assertEq(beacon.implementation(), address(implV1));
    }
}
```

- [ ] **Step 2: Run it; confirm it passes**

Run: `forge test --match-path test/solidity/VaultWrapper/BeaconUpgrade.t.sol -vvv`
Expected: PASS. (If `FeeConfig`'s fixed-size arrays make the struct literal `FeeConfig memory fees;` insufficient, mirror the exact construction used in `LiFiVaultWrapperFactory.t.sol`'s deploy helper — check that file for the canonical `DeployParams`/`FeeConfig` literal before adjusting.)

- [ ] **Step 3: Commit**

```bash
git add test/solidity/VaultWrapper/BeaconUpgrade.t.sol
git commit -m "test(EXSC-416): clone delegates to current beacon impl"
```

---

## Task 3: Test — upgrade propagates to all existing clones

**Files:**

- Modify: `test/solidity/VaultWrapper/BeaconUpgrade.t.sol`

The core S9 guarantee: one `beacon.upgradeTo` re-points every clone, including clones deployed *before* the upgrade. Deploy two clones on V1, confirm `version()` reverts (V1 has no such selector), upgrade the beacon to V2, then assert both pre-existing clones now answer `version() == 2`, and that a clone deployed *after* the upgrade does too.

- [ ] **Step 1: Add the test**

```solidity
    function test_UpgradePropagatesToAllExistingClones() public {
        address cloneA = _deployClone(0);
        address cloneB = _deployClone(1);

        // V1 has no version() selector — the call reverts before the upgrade.
        vm.expectRevert();
        MockVaultWrapperV2(cloneA).version();

        vm.prank(owner);
        beacon.upgradeTo(address(implV2));

        assertEq(beacon.implementation(), address(implV2));
        assertEq(MockVaultWrapperV2(cloneA).version(), 2);
        assertEq(MockVaultWrapperV2(cloneB).version(), 2);

        address cloneC = _deployClone(2);
        assertEq(MockVaultWrapperV2(cloneC).version(), 2);
    }
```

- [ ] **Step 2: Run it; confirm it passes**

Run: `forge test --match-test test_UpgradePropagatesToAllExistingClones -vvv`
Expected: PASS — both pre-upgrade clones report V2 behavior after a single `upgradeTo`.

- [ ] **Step 3: Commit**

```bash
git add test/solidity/VaultWrapper/BeaconUpgrade.t.sol
git commit -m "test(EXSC-416): beacon upgrade propagates to all existing clones"
```

---

## Task 4: Test — upgrade is owner-gated, and rejects non-contract impl

**Files:**

- Modify: `test/solidity/VaultWrapper/BeaconUpgrade.t.sol`

Proves "only the (governance) owner can upgrade" and that `upgradeTo` rejects an EOA/non-contract (OZ `UpgradeableBeacon` reverts `"UpgradeableBeacon: implementation is not a contract"`). The non-owner path is the S9-side of the eventual timelock gating (S10 swaps `owner` for the timelock; the gating mechanism is identical).

- [ ] **Step 1: Add both tests**

```solidity
    function test_OnlyOwnerCanUpgrade() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        beacon.upgradeTo(address(implV2));

        assertEq(beacon.implementation(), address(implV1));
    }

    function test_UpgradeToNonContractReverts() public {
        vm.prank(owner);
        vm.expectRevert("UpgradeableBeacon: implementation is not a contract");
        beacon.upgradeTo(makeAddr("eoa"));
    }
```

- [ ] **Step 2: Run them; confirm they pass**

Run: `forge test --match-test "test_OnlyOwnerCanUpgrade|test_UpgradeToNonContractReverts" -vvv`
Expected: both PASS. (If the OZ revert strings differ in the pinned v4.9.0 source, read `lib/openzeppelin-contracts/contracts/proxy/beacon/UpgradeableBeacon.sol` and match the exact string — verify at write time, do not trust memory.)

- [ ] **Step 3: Commit**

```bash
git add test/solidity/VaultWrapper/BeaconUpgrade.t.sol
git commit -m "test(EXSC-416): beacon upgrade is owner-gated and rejects non-contract impl"
```

---

## Task 5: Standalone beacon deploy script

**Files:**

- Create: `script/deploy/facets/DeployVaultWrapperBeacon.s.sol`

A separable beacon deploy so the beacon can be deployed and owned independently of the factory (the S9 "beacon deploy" deliverable; S14 folds it into the full deploy flow). Mirrors the env-driven style of `DeployLiFiVaultWrapperFactory.s.sol`.

- [ ] **Step 1: Write the script**

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import { MockVaultWrapper } from "lifi/VaultWrapper/mocks/MockVaultWrapper.sol";

/// @title DeployVaultWrapperBeacon
/// @author LI.FI (https://li.fi)
/// @notice Deploys the wrapper implementation and its UpgradeableBeacon, then
///         transfers beacon ownership to the governance owner. The mock impl is
///         a temporary stand-in until S1. Reads OWNER from environment.
/// @dev Deploy order: MockVaultWrapper -> UpgradeableBeacon(impl) -> transferOwnership(OWNER).
///      Gating the beacon owner behind the 48h timelock is S10 (EXSC-418).
/// @custom:version 1.0.0
contract DeployScript is Script {
    error ZeroPrivateKey();
    error ZeroOwner();

    function run()
        public
        returns (UpgradeableBeacon beacon, MockVaultWrapper impl)
    {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address owner = vm.envAddress("OWNER");

        if (deployerPrivateKey == 0) revert ZeroPrivateKey();
        if (owner == address(0)) revert ZeroOwner();

        vm.startBroadcast(deployerPrivateKey);
        impl = new MockVaultWrapper();
        beacon = new UpgradeableBeacon(address(impl));
        beacon.transferOwnership(owner);
        vm.stopBroadcast();
    }
}
```

- [ ] **Step 2: Verify it compiles and runs against a local fork stub**

Run: `forge build`
Expected: compiles. (A full broadcast run is exercised by S14; here `forge build` confirms the script is well-formed. Do not run `--broadcast`.)

- [ ] **Step 3: Commit**

```bash
git add script/deploy/facets/DeployVaultWrapperBeacon.s.sol
git commit -m "feat(EXSC-416): standalone vault wrapper beacon deploy script"
```

---

## Task 6: Impl-registration (upgrade) script

**Files:**

- Create: `script/deploy/facets/RegisterVaultWrapperImpl.s.sol`

The impl-registration entrypoint S9 calls for: a governance-run `upgradeTo`. Because the beacon owner is governance (and S10 will make it the timelock), this script is meant to be run *by* the owner — in production the call is wrapped in a timelock operation; the script body is just the `upgradeTo` payload.

- [ ] **Step 1: Write the script**

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { UpgradeableBeacon } from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

/// @title RegisterVaultWrapperImpl
/// @author LI.FI (https://li.fi)
/// @notice Points the UpgradeableBeacon at a new wrapper implementation,
///         atomically upgrading every existing clone. Must be called by the
///         beacon owner (governance; the 48h timelock once S10 lands).
/// @dev Reads BEACON and NEW_IMPL from environment. In production this call is
///      scheduled/executed through the timelock; here it is the raw payload.
/// @custom:version 1.0.0
contract DeployScript is Script {
    error ZeroPrivateKey();
    error ZeroBeacon();
    error ZeroImpl();

    function run() public {
        uint256 ownerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address beaconAddress = vm.envAddress("BEACON");
        address newImpl = vm.envAddress("NEW_IMPL");

        if (ownerPrivateKey == 0) revert ZeroPrivateKey();
        if (beaconAddress == address(0)) revert ZeroBeacon();
        if (newImpl == address(0)) revert ZeroImpl();

        vm.startBroadcast(ownerPrivateKey);
        UpgradeableBeacon(beaconAddress).upgradeTo(newImpl);
        vm.stopBroadcast();
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `forge build`
Expected: compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add script/deploy/facets/RegisterVaultWrapperImpl.s.sol
git commit -m "feat(EXSC-416): vault wrapper impl-registration (upgradeTo) script"
```

---

## Task 7: Full suite + lint + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full VaultWrapper suite**

Run: `forge test --match-path "test/solidity/VaultWrapper/*" -vv`
Expected: all VaultWrapper tests pass (the S8 set plus the new `BeaconUpgrade.t.sol`).

- [ ] **Step 2: Lint the new Solidity**

Run: `bunx solhint "test/solidity/VaultWrapper/mocks/MockVaultWrapperV2.sol" "test/solidity/VaultWrapper/BeaconUpgrade.t.sol" "script/deploy/facets/DeployVaultWrapperBeacon.s.sol" "script/deploy/facets/RegisterVaultWrapperImpl.s.sol"`
Expected: 0 errors.

- [ ] **Step 3: Format**

Run: `bun format:fix`
Expected: no diff, or only formatting normalizations on the new files.

- [ ] **Step 4: Local CodeRabbit pre-flight**

Run `/pr-ready` with base `feature/exsc-417-s8-factory`:
`coderabbit review --base feature/exsc-417-s8-factory --type committed --plain`
Resolve actionable findings, clear the gate marker.

- [ ] **Step 5: Push and open the PR (base = S8 branch)**

```bash
git push -u origin feature/exsc-416-s9-beacon-upgrade-wiring
gh pr create --base feature/exsc-417-s8-factory --draft \
  --title "feat(EXSC-416): beacon upgrade wiring (S9) — upgrade tests + deploy/registration scripts"
```

Fill the PR body from `.github/pull_request_template.md`; link EXSC-416; note it stacks on #1936 and that beacon-owner→timelock gating is S10.

---

## Self-Review

**Spec coverage (EXSC-416 deliverables):**

- "UpgradeableBeacon holding impl" + "clones as BeaconProxy reading impl each call" → already in S8; **proven** by Task 2.
- "upgrade changes behavior for all clones" → Task 3.
- "beacon upgrade entrypoint gated to the timelock" → owner-gating proven in Task 4; the *timelock instance* is explicitly S10 (noted in Scope decision 2). Gap is intentional and assigned to S10.
- "only timelock can upgrade" → Task 4 proves owner-gating; S10 substitutes the timelock for the owner. Documented.
- "beacon deploy + impl-registration script" → Tasks 5 and 6.
- "clones delegate to current impl" (A1) → Task 2.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The one conditional note (FeeConfig literal in Task 2 / OZ revert strings in Task 4) directs the engineer to verify against the exact pinned source rather than guess — this is a verification instruction, not a placeholder.

**Type consistency:** `DeployParams`/`FeeConfig`/`FeeType` imported from `LiFiVaultWrapperTypes.sol` (matches S8 test usage). `MockVaultWrapperV2` keeps `MockVaultWrapper`'s exact storage layout + `initialize` signature. `_deployClone` helper signature is consistent across Tasks 2–4. Beacon owner is `owner` throughout. Env var names (`OWNER`, `BEACON`, `NEW_IMPL`, `PRIVATE_KEY`) consistent with `DeployLiFiVaultWrapperFactory.s.sol`.

**Known follow-ups (out of scope, flagged):**

- OZ `UpgradeableBeacon`'s single-step `Ownable` + `renounceOwnership` vs the repo's two-step `TransferrableOwnership` — governance hardening decision for S10.
- Folding the standalone scripts into `DeployScriptBase`/CREATE3/deployment-log is S14 (EXSC-420).
