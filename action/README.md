# TokenZero cost check (GitHub Action)

Audits each pull request's changes for LLM token waste and keeps one comment on the PR up to date: uncached static prompts, frontier models on extraction or classification prompts, LLM calls inside loops, unpriced model ids. It runs entirely on your runner. There is no account, no API key, and your code is not uploaded.

```yaml
name: TokenZero cost check
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  cost-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: tokenzero-ai/tokenzero/action@v0
        # with:
        #   fail-over: 30          # fail the check above 30% estimated recoverable waste
        #   comment-on-clean: true # also comment when the changes have no findings
```

| Input | Default | |
|---|---|---|
| `github-token` | `${{ github.token }}` | Posts the PR comment. Fork PRs get a read-only token; results then go to the job summary only. |
| `fail-over` | empty | Fail the check when estimated recoverable waste exceeds this percentage. |
| `comment-on-clean` | `false` | Comment even when the changes have no findings. An existing comment is always updated, so a fixed PR shows it is fixed. |
| `path` | `.` | Directory to audit on non-PR events (push, schedule), which write the job summary only. |

Outputs: `waste-pct`, `findings`, `high`.

Findings are **static heuristics**: estimates at list prices, not measurements. Library and SDK repositories are detected and their findings downgraded.

Apache-2.0 · part of [TokenZero tools](https://github.com/tokenzero-ai/tokenzero)
