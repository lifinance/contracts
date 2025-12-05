# Scripts & CI

[CONV:SCRIPTS-TS]

- TS scripts use `.eslintrc.cjs` rules, `bunx tsx`, `citty`, `consola`, and env validated via helpers (e.g., `getEnvVar()`).
- MUST use viem for all contract interactions in demo/operational scripts; ethers.js helpers are deprecated.
- ALWAYS reuse existing helpers where available, in particular:
  - `script/utils/deploymentHelpers.ts` (deployment loading helpers),
  - `script/demoScripts/utils/demoScriptHelpers.ts` (viem-based demo helpers and swap helpers).
- DO NOT use deprecated ethers-based helpers (`getProvider`, `getWalletFromPrivateKeyInDotEnv`, ethers `sendTransaction`, `ensureBalanceAndAllowanceToDiamond`).
- New TypeScript helpers require colocated `{name}.test.ts` with 100% coverage using Bun (`describe` / `it` / `expect`).

[CONV:BASH]

- Bash deploy wraps Foundry; robust retries; modular functions; helpers; early env validation.

[CONV:DEPLOY]

- Foundry deploy/update script patterns (`Deploy*.s.sol`, `Update*.s.sol`) with JSON config via `stdJson`.

[CONV:AUDIT-DOCS]

- Audit logs in `audit/` with `auditLog.json`; reports under `audit/reports/`.

[CONV:GHA]

- Workflows: explicit permissions, comments, secrets via `${{ secrets.* }}`; clear step names & triggers.
