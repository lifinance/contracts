@.agents/context.md

## Hooks

Post-edit hooks in `.agents/hooks/` run automatically after every Write/Edit:
- `post-edit-format.sh` — prettier on `.sol`/`.ts`/`.js` (silent, always runs)
- `post-edit-validate.sh` — solhint / tsc-files / bash -n (reports errors back to Claude)
