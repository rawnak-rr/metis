# MCP evaluations

The real-vault harness exercises Metis through an actual in-memory MCP client/server connection. It does not call service classes directly and does not require a model API key.

To evaluate an existing private vault without changing it:

```sh
npm run eval:real-vault -- /absolute/path/to/vault
```

That harness hashes the original tree, copies it to a temporary directory, migrates and queries only the copy, verifies keyed routing and payload budgets, checks the original hash again, writes a content-free report, and removes the copy in a `finally` block.

It also compares the former full-scan BM25 token work with the checksum-keyed incremental index across related questions, and separately measures compact answer-packet bytes with and without explicit same-context evidence reuse. Retrieval work counts lexical source-token visits plus posting-list visits; model tokens are conservatively estimated as JSON bytes divided by four and are not provider billing telemetry.

Protocol and grounding behavior beyond that is covered by the test suite (`npm test`). Retrieval *quality* is not measured anywhere yet — there is no recall@k or MRR over labeled question/span pairs.
