# Contributing to Metis

Metis handles personal study data, so correctness, provenance, and recoverability take priority over feature count.

## Development setup

```sh
npm ci
npm run typecheck
npm test
npm run eval:ci
```

PDF ingestion requires Poppler's `pdftotext`. PDF rendering requires `pdflatex`.

## Change requirements

- Add a regression test for every bug fix.
- Add or update an MCP evaluation when behavior is visible through a tool, resource, or prompt.
- Never weaken a critical safety check merely to restore the aggregate score.
- Add an ordered migration whenever persisted state or config changes.
- Migrations must be deterministic, retryable, backed up, and must not modify `raw/`.
- Do not commit personal vaults, `.metis/`, raw study materials, exports, or evaluation output.

## Pull requests

Describe:

1. the user-visible problem;
2. the invariant or learning behavior introduced;
3. the tests/evaluations proving it;
4. migration and compatibility impact;
5. remaining limitations.

The deterministic evaluation score is a regression signal, not proof of educational effectiveness. Claims about learning quality require appropriate evaluation evidence.

