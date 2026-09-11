---
name: TypeScript tests
description: Bun test structure, coverage, and expectations for `.test.ts`
globs:
  - '**/*.test.ts'
paths:
  - '**/*.test.ts'
---

## TypeScript Tests

- Use Bun (`describe` / `it` / `expect`).
- Cover edge cases and error paths.

## Unit tests and external calls ([CONV:UNIT-MOCK-EXTERNAL])

- **Mock external I/O** in unit tests: do not call real HTTP APIs, RPC endpoints, or other out-of-process services from tests. Stub `globalThis.fetch`, RPC clients, or other dependencies so tests are fast, deterministic, and free of network flakiness.
- **Restore after each test**: when stubbing globals (e.g. `globalThis.fetch`), save the original in `beforeEach`/`beforeAll` and restore it in `afterEach`/`afterAll` to avoid cross-test pollution.
- Prefer true unit tests that isolate the code under test; use mocks for any outbound calls (fetch, contract calls, file system if needed) so failures reflect logic bugs, not environment or network issues.

## Withholding credentials from a spawned child ([CONV:TEST-SPAWN-CREDENTIALS])

A test that spawns a child must **set** every credential name to a dummy, never
`delete` it. Bun re-loads the repo `.env` inside the child for every name the
passed environment leaves unset, so deleting a name hands the real value back at
full length. Use `withholdCredentials()` from
`script/deploy/safe/spawn-env.ts` rather than rolling your own.

A name is a credential when it carries one of the cores in that module's class
table — today `PRIVATE_KEY`, `MNEMONIC`, `MONGODB_URI`, `ETH_NODE_URI`,
`API_KEY`, `ACCESS_KEY`, `SYNC_TOKEN`, `WEBHOOK`. The cores are anchored on the
credential-bearing suffix, not the vendor, so a name that merely shares a prefix
is not swept up; a name that holds no secret despite matching a core belongs in
the same module's reviewed non-credential set, with the reason.

`script/spawn-env-credentials.test.ts` derives its source scan from those same
cores, so the guard and the withholding widen together. Two consequences:

- **Deleting one of these names is red**, including in a test that never spawns.
  When the delete is legitimate — an in-process test, or a child whose `cwd`
  holds no `.env` — annotate it with a trailing `// spawn-env: <reason>` comment
  on the delete's own line. The marker only counts on that line, so keep the
  reason short enough to survive prettier at 80 columns; restructure the
  statement rather than letting the formatter move the comment off it.
- **A credential whose name carries no core is invisible** to both the scan and
  the sweep. Adding a new kind of secret to the store means adding its core,
  not assuming the pattern grew.

## Asserting rejections ([CONV:TEST-ASSERT-REJECTS])

- **Never assert rejections via `expect(...).rejects`** — awaiting Bun's matcher trips `@typescript-eslint/await-thenable` because it isn't a real Promise. Use a local `async function expectRejects(promise, match)` that catches and matches the error message, as in `script/deploy/safe/parked-tasks.test.ts`.

## Post-Change Actions

- After TS test changes, run Bun tests (or state which suites remain).
