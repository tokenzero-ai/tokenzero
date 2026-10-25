# @tokenzero/cli

Command line for [TokenZero](https://tokenzero.sh): audit LLM token waste in a project, connect it to the TokenZero bring-your-own-key gateway, check usage, and verify signed savings receipts.

```sh
npx -y @tokenzero/cli audit                    # local static audit; nothing is uploaded
npx -y @tokenzero/cli audit --json
npx -y @tokenzero/cli audit --fail-over 30     # CI gate: exit 1 above 30% recoverable
git diff origin/main | npx -y @tokenzero/cli audit --diff - --format markdown
```

Audits are **static heuristics**: they read code, not traffic, and report estimates at list prices. Library and SDK repositories are detected and their findings downgraded.

## Connecting to the gateway

These commands talk to the hosted gateway at `https://tokenzero.sh`. To use another deployment, pass `--url` or set `TOKENZERO_URL`.

```sh
npx -y @tokenzero/cli init        # audit, create a workspace, write base URLs to .env (asks first)
npx -y @tokenzero/cli usage       # routed spend vs the free tier, savings
npx -y @tokenzero/cli verify <request_id>   # check a receipt's Ed25519 signature locally
npx -y @tokenzero/cli rotate-key  # new workspace key; rewrites it in .env
```

**Authentication.** Send your workspace key as the `X-TokenZero-Key` header; this is the recommended form. Your provider key is sent exactly as you would send it to the provider and passes through untouched. For setups where you cannot add headers, `init` can embed the workspace key in the base URL (`<gateway>/w/<key>/v1`). Treat such URLs as secrets, and run `rotate-key` if one leaks into logs.

Node >= 18. Single file, no dependencies. Apache-2.0.
