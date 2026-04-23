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

## Post-Change Actions

- After TS test changes, run Bun tests (or state which suites remain).
