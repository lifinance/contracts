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

## Asserting on process-level behavior ([CONV:TEST-PROCESS-SURFACE])

Don't reach for a spy or a Bun matcher when asserting that code wrote to stdout, exited, or rejected — both routes fail for reasons unrelated to the code under test.

- **Never assert via `spyOn(process.stdout, 'write')`** (same for `process.exit`). The spy does not capture writes made by the code under test — the assertion reports "was not called" even though the write happens (observed on Bun 1.3.8). Instead **inject the output/exit surface as a parameter defaulting to `process`** and pass a recorder in the test. `reportApprovalResult(failures, target: IReportTarget = process)` in `script/deploy/github/verify-approvals.ts` is the reference shape: production callers pass nothing, the test passes a fake and asserts on what it captured.
- **Never assert rejections via `expect(...).rejects`** — awaiting Bun's matcher trips `@typescript-eslint/await-thenable` because it isn't a real Promise. Use a local `async function expectRejects(promise, match)` that catches and matches the error message, as in `script/deploy/safe/parked-tasks.test.ts`.

## Post-Change Actions

- After TS test changes, run Bun tests (or state which suites remain).
