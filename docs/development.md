# Development

## Type-check the plugins

Each plugin has a `tsconfig.json` that extends the engine's generated one, so both are checked the same way:

```sh
npx --yes -p typescript@5 tsc -p plugins/goal-pin
npx --yes -p typescript@5 tsc -p plugins/project-dashboard
```

Both commands should exit 0 with no output.

### Prerequisite: generate the engine types

The engine's API types are not in the repo. The engine writes them to
`plugins/<name>/.claude-plugin/types/` (`claude-code/`, `claude-code-mcp/`,
`claude-code-tools/` and `tsconfig.json`) when an interactive session loads the plugin.
The folder is gitignored and per-plugin, so do this once for each plugin, and again after
upgrading Claude Code to refresh the types:

1. From the repo root, start `claude --plugin-dir "$PWD/plugins/<name>"`.
2. Answer the "do you trust this folder" prompt with the second option.
3. Wait a few seconds, then exit.
4. Confirm `plugins/<name>/.claude-plugin/types/tsconfig.json` exists.

Headless runs do not generate the types: `claude --plugin-dir ... -p "/goal"`,
`claude plugin test .` and `claude plugin validate .` all leave the folder absent.

A fresh checkout has no generated types, so type-checking is a local step. It is not run
in CI because it needs an interactive engine load.

## Tests and validation

```sh
cd plugins/<name> && claude plugin test . && claude plugin validate .
```

## When a pull request touches the tests

Type your test helpers against the engine's own types, which `tsc` enforces:

- Type `on` and `$` with `import type { TestBody } from 'claude-code/testing'`, as
  `Parameters<TestBody>[1]` (`on`) and `Parameters<TestBody>[0]` (`$`). The older
  `Parameters<Parameters<typeof test>[1]>[n]` pattern is rejected, because `test` takes
  rest arguments and that resolves to `TestBody | TestOptions`.
- Process results use `isStdoutTruncated` and `isStderrTruncated`, not `isTruncated`.
