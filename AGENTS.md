# Repository Guidelines

## Project Structure & Module Organization

- `src/`: TypeScript source (ESM). Entry point is `src/index.ts`.
  - `src/exchange/`: Exchange instances, credentials, symbol validation (e.g., `manager.ts`).
  - `src/tools/`: MCP tools grouped by domain (`public.ts`, `private.ts`, `config.ts`, `onchain.ts`, `telegram.ts`).
  - `src/utils/`: Caching, logging, rate limiting, and indicators.
- `build/`: Compiled output from `tsc` (generated; do not edit).
- `bin/`: CLI entry (`bin/cli.js`) used by the published `mcp-server-ccxt` command.
- `docs/`: Diagrams and troubleshooting docs.
- `assets/`: Images referenced by docs/README.

## Build, Test, and Development Commands

- `npm install`: Install dependencies.
- `npm run build`: Compile TypeScript into `build/`.
- `npm run dev`: Watch mode compilation (`tsc -w`) for local development.
- `npm start`: Run the MCP server from `build/index.js` (stdio-based; no port required).
- `docker build -t mcp-server-ccxt .`: Build a container image.
- `docker run --rm --env-file .env mcp-server-ccxt`: Run in Docker with local config.

## Coding Style & Naming Conventions

- Use TypeScript in `src/` and follow existing module boundaries (`exchange/`, `tools/`, `utils/`).
- Indentation: 2 spaces; prefer small, focused modules.
- Filenames: lowercase with hyphens (e.g., `rate-limiter.ts`, `ma-band-osc.ts`).
- Keep tool names and behavior stable: they are user-facing APIs. Document changes in `README.md` and/or `CHANGELOG.md`.

## Testing Guidelines

- No automated test suite is currently configured (`npm test` exits with an error).
- For changes, at minimum run `npm run build` and do a smoke run via `npm start` or `node bin/cli.js`.

## Commit & Pull Request Guidelines

- Commit messages in this repo are typically imperative and concise (e.g., "Update CCXT dependency...", "Add support..."). Optional prefixes like `[feat]` are acceptable.
- PRs should include: a clear summary, affected tool/resource names (if any), config/env changes (e.g., `.env.example` updates), and any docs/diagram updates in `docs/` when behavior changes.

## Security & Configuration Tips

- Never commit secrets. Use `.env` locally; keep `.env.example` up to date for new settings.
- Prefer env-based credentials over inline tool parameters; keep `ALLOW_INLINE_CREDENTIALS=false` unless you explicitly need otherwise.

