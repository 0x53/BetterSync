# Contributing

Issues and pull requests are welcome. BetterSync's scope is deliberately narrow (see the non-goals in [docs/DESIGN.md](docs/DESIGN.md#goals-and-non-goals)), so for anything beyond a bug fix, open an issue first.

- Requires [Bun](https://bun.sh) 1.4 or later. `bun install`, then `bun test` and `bun run typecheck` before sending a PR; CI runs both.
- Changes to the sync engine or merge should keep the simulator and fuzz runs green at higher counts too: `bun run sim`, `bun run fuzz`, and `bun run kill` for anything touching the server or headless client. A failure prints a seed; see the README for replaying it.
- Changes to the plugin should also pass `bun run obsidian` against a real Obsidian if you can (see "Plugin tests" in the README).
- By contributing you agree that your contribution is licensed under the project's [0BSD license](LICENSE).
