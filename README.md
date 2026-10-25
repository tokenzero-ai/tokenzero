# TokenZero tools

Open-source tools from [TokenZero](https://tokenzero.sh), the bring-your-own-key gateway that cuts OpenAI, Anthropic and Gemini bills.

- **`@tokenzero/mcp`** is a stdio MCP server for Claude Code, Cursor, Windsurf and Cline: audit the open project for token waste (locally), price model alternatives, make request bodies cache-friendly.
- **`@tokenzero/cli`** connects a project to the gateway with no code changes, audits LLM token waste locally, shows usage and verifies signed savings receipts.
- **The analyzer** (`src/audit-core.ts`) is the static token-waste audit used by the CLI, the hosted repo audit and the PR cost-diff check. It runs entirely on your machine.
- **The pricing table** (`src/pricing.ts`) lists the list prices every estimate is computed from, versioned and dated.

## Audit a project

```sh
npx -y @tokenzero/cli audit            # local, nothing is uploaded
npx -y @tokenzero/cli audit --json
npx -y @tokenzero/cli audit --fail-over 30   # CI gate: exit 1 above 30% recoverable
git diff origin/main | npx -y @tokenzero/cli audit --diff - --format markdown
```

Audits are **static heuristics**: they read code, not traffic. Numbers are estimates at list prices; verified savings come from the gateway's signed ledger once requests flow through it.

What it looks for:

- large static prompts sent without caching directives (Anthropic `cache_control`, OpenAI prefix stability)
- prompt templates defined away from their call sites with no caching anywhere
- frontier models on prompts that read like extraction or classification
- LLM calls inside loops (Batch API or shared-prefix caching candidates)
- unpriced or retired model ids

Library and SDK repositories are detected and their findings downgraded, since their call sites pass through whatever the caller chooses.

## Use it from a coding agent (MCP)

```sh
claude mcp add tokenzero -- npx -y @tokenzero/mcp          # Claude Code
```

```json
{ "mcpServers": { "tokenzero": { "command": "npx", "args": ["-y", "@tokenzero/mcp"] } } }
```

`audit_repo_token_waste` and `calculate_model_arbitrage` run entirely on your machine. `optimize_prompt_payload` sends the request body you give it to the TokenZero service (set `TOKENZERO_URL`), so do not put secrets in it.

## Connect a project to the gateway

```sh
npx -y @tokenzero/cli init
```

`init` audits locally, creates a workspace, and (with your consent) adds `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` to `.env`. Your provider keys pass through untouched and are never stored.

Authentication: send the workspace key as the `X-TokenZero-Key` header (recommended). For zero-code setups the CLI can also embed it in the base URL (`/w/<key>/v1`); treat such URLs as secrets and use `tokenzero rotate-key` if one leaks.

## Develop

```sh
npm install
npm run build      # bundles cli/bin/tokenzero.mjs (single file, no runtime deps)
npm test
```

License: Apache-2.0 · support@tokenzero.sh
