# @tokenzero/mcp

A stdio [MCP](https://modelcontextprotocol.io) server from [TokenZero](https://tokenzero.sh) that lets coding agents find and fix LLM cost waste.

```sh
claude mcp add tokenzero -- npx -y @tokenzero/mcp     # Claude Code
```

```json
{ "mcpServers": { "tokenzero": { "command": "npx", "args": ["-y", "@tokenzero/mcp"] } } }
```

| Tool | Runs | What it does |
|---|---|---|
| `audit_repo_token_waste` | locally | Static audit of a local directory (default: the working directory), a public GitHub repo, or a diff. Nothing from a local directory is uploaded. |
| `calculate_model_arbitrage` | locally | Prices a workload across models at list prices, with and without prompt caching. |
| `optimize_prompt_payload` | TokenZero service | Rewrites a request body so its static prefix is cacheable. Sends the body you pass to the TokenZero service (`https://tokenzero.sh` unless `TOKENZERO_URL` is set); do not include secrets. |

Optional environment: `TOKENZERO_URL` (another gateway for `optimize_prompt_payload`; default `https://tokenzero.sh`), `GITHUB_TOKEN` (raises GitHub rate limits for repo audits).

Audits are static heuristics: estimates at list prices, not measurements. Node >= 18. Single file, no dependencies. Apache-2.0.
