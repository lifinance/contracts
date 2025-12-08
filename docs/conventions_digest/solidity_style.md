# Solidity Style & Licensing

[CONV:LICENSE]

- Our own files: `// SPDX-License-Identifier: LGPL-3.0-only` immediately followed by the pragma statement with no blank line in between.

- External copies retain original license + source note.

- Keep pragma per `foundry.toml`.

[CONV:NAMING]

- Interfaces start with `I*`; functions/vars camelCase; constants & immutables are CONSTANT_CASE.

- Params use leading underscore (e.g., `_amount`).

[CONV:NATSPEC]

- Contracts & interfaces must include:

  - `@title`, `@author LI.FI (https://li.fi)`

  - `@notice`, `@custom:version X.Y.Z`

- Public/external functions require NatSpec including params/returns.

[CONV:BLANKLINES]

- Single blank line between logical sections and between function declarations.

- Follow in-function blank-line rules (before emits/returns; no stray gaps).

