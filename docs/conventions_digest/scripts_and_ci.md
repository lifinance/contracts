# Scripts & CI

[CONV:SCRIPTS-TS]

- TS scripts use `.eslintrc.cjs` rules, `bunx tsx`, `citty`, `consola`, env validated via helpers.

- ALWAYS use existing helpers (getDeployments, getProvider, getWalletFromPrivateKeyInDotEnv,

  sendTransaction, ensureBalanceAndAllowanceToDiamond, getUniswapData*).

- 100% unit test coverage for new TS helpers using Bun.

[CONV:BASH]

- Bash deploy wraps Foundry; robust retries; modular functions; helpers; early env validation.

[CONV:DEPLOY]

- Foundry deploy/update script patterns (`Deploy*.s.sol`, `Update*.s.sol`) with JSON config via `stdJson`.

[CONV:AUDIT-DOCS]

- Audit logs in `audit/` with `auditLog.json`; reports under `audit/reports/`.

[CONV:GHA]

- Workflows: explicit permissions, comments, secrets via `${{ secrets.* }}`; clear step names & triggers.

