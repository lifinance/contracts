@.agents/context.md

## Hooks

`.agents/hooks/post-edit-validate.sh` runs after every Write/Edit:

- formats the file first via `post-edit-format.sh` (oxfmt on `.ts`/`.js`, prettier on `.sol`, silent)
- then runs solhint / typecheck-files.sh / bash -n and feeds any findings back to Claude
  (stderr + exit 2; a clean file stays silent)
