# Per-Circuit Timing Breakdown

Measured 2026-08-04 on Apple Silicon (macOS, Docker Desktop), standalone stack
(`proof-server:4.0.0`, `midnight-node:0.12.0`, `indexer-standalone:2.1.1`).
Server-side times from the proof-server actix access log; consensus/indexing
times cross-referenced from node and indexer logs. Reference runs:
`logs/bench-2026-08-04T*.log`.

## Headline numbers

| Component                              | constructor | proveOwnership | burnAsset |
|----------------------------------------|-------------|----------------|-----------|
| Pure PLONK circuit proof (server-side) | ~1 ms       | ~1,895 ms      | ~1,877 ms |
| HTTP + serialization overhead          | ~10 ms      | ~9 ms          | ~7 ms     |
| Zswap tx-wrapper proof (server-side)   | ~5,700 ms   | ~4,500 ms      | ~4,400 ms |
| Balancing + local witness (harness)    | ~70 ms      | ~80 ms         | ~70 ms    |
| Consensus + indexing (when awaited)    | ~15,400 ms  | n/a            | n/a       |

## constructor — total ~21 s

A deployment transaction contains **no circuit proof at all**: the HTTP proof
provider sends `zkConfig: undefined` for deploys, and the server-side
`/prove-tx` handler completes in ~1–3 ms (passthrough). The recorded
`circuitProofMs` (~11–14 ms) is almost entirely HTTP round-trip.

| Phase                                                | Time       | Share |
|------------------------------------------------------|------------|-------|
| Build deploy tx + local witness                      | ~29 ms     | 0.1%  |
| `/prove-tx` (no-op for deploys)                      | ~11 ms     | 0.05% |
| `balanceTransaction` (wallet SDK)                    | ~40 ms     | 0.2%  |
| Zswap wallet proof (`/prove-tx` #2)                  | ~5,700 ms  | 27%   |
| Submit → block inclusion (mempool wait)              | ~1,600 ms  | 8%    |
| Finalization + indexing (2-block depth × ~6 s blocks)| ~13,400 ms | 64%   |
| Indexer → harness notification                       | ~350 ms    | 1.7%  |

Note: dev-node blocks are ~6 s apart (not 15–20 s as previously documented);
the dominant wait is the indexer only indexing **finalized** blocks.

## proveOwnership — measured span ~1.9 s (full pipeline ~6.5 s)

| Phase                                        | Time        | Recorded?           |
|----------------------------------------------|-------------|---------------------|
| Join contract (state fetch, no proof)        | ~64 ms      | no                  |
| Local witness + tx assembly                  | ~22 ms      | inside span         |
| **PLONK circuit proof** (server-side)        | ~1,895 ms   | = `circuitProofMs`  |
| `balanceTransaction`                         | ~60 ms      | background          |
| Zswap wallet proof                           | ~4,500 ms   | background (¹)      |
| Submit + confirmation                        | not awaited | —                   |

(¹) The built-in summary reports `walletProofMs=0` for this circuit (known
bug); real values are in the log lines `wallet.proveTransaction done`.

## burnAsset — measured span ~1.88 s (full pipeline ~6.3 s)

Identical structure to proveOwnership (circuits differ by 5 rows). Each
iteration additionally requires an untimed setup deploy (~17 s, dominated by
the same finality wait).

## Where the ~1.9 s PLONK time goes

Every `/prove-tx` call uploads the full ZK config — 5.5 MB prover key,
verifier key, and ZKIR — with the request (the server is stateless per
circuit; upload cost is ~10 ms on localhost). The remaining time is pure
prover compute (container observed at ~730–770% CPU — Pippenger MSM buckets
and FFT butterflies parallelize across cores):

| Stage                | Work                                                        | Share (typical) |
|----------------------|-------------------------------------------------------------|-----------------|
| Witness synthesis    | Execute ZKIR, fill assignment matrix                        | ~5%             |
| Column commitments   | 8 advice + 9 permutation + 3 lookup commitments — MSMs of 8,192 BLS12-381 G1 points each | ~50–65% |
| Quotient polynomial  | Coset FFTs over extended domain 4n = 32,768 (max_deg=5), vanishing division, quotient commitments | ~25–35% |
| KZG openings         | 60 column queries batched into opening proofs               | ~10%            |

## Cold vs. warm proving (3-iteration run, `logs/bench-2026-08-04T10-17-35.854Z.log`)

The **first** proof of each circuit is ~35% slower than subsequent ones:

| Iteration       | proveOwnership | burnAsset |
|-----------------|----------------|-----------|
| 1 (cold)        | 1,968 ms       | 1,951 ms  |
| 2 (warm)        | 1,429 ms       | 1,453 ms  |
| 3 (warm)        | 1,395 ms       | (run aborted — see below) |

The warm-up is **per circuit**, not per k: burnAsset's first proof was still
cold (1,951 ms) even though proveOwnership had already proven three k=13
proofs. The ~500 ms delta is one-time processing of the uploaded 5.5 MB
prover key (deserialization/expansion), cached server-side by content
thereafter. Steady-state PLONK cost is therefore **~1.4 s** per proof on this
machine, ~1.95 s cold. The Zswap wrapper proof shows the same effect once
globally (first: 5.7 s, thereafter: 4.0–4.6 s).

Note: at `BENCH_ITERATIONS=3` the run aborted on the final burnAsset proof —
the proof server rejected the request after ~34 blocks of accumulated chain
state and the proof-only wait then hung until the vitest timeout (68 min).
This is the instability class the README works around by running
`BENCH_ITERATIONS=1` with a stack restart per run.

## Circuit model (from `zkir mock-compile -v`)

```
proveOwnership: k=13, rows=4186, table_rows=7933, nb_unusable_rows=7,
                max_deg=5, advice_columns=8, fixed_columns=43,
                lookups=3, permutations=9, column_queries=60, point_sets=5
burnAsset:      k=13, rows=4181, table_rows=7933  (rest identical)
```

Key observations:

- **k=13 → evaluation domain n = 8,192** (per zkir 0.31.1's model; the
  shipped keys were built with the 0.25-era toolchain, which may pad
  differently — treat as the structure of the cost, not bit-exact).
- **The single `persistent_hash` call dominates**: both circuits are ~52 ZKIR
  instructions, almost all trivial public-input plumbing — but the
  SHA-family lookup tables behind `persistent_hash` occupy **7,933 of 8,192
  rows**. The circuit is lookup-table-bound; one more hash would overflow to
  k=14 and roughly double proving time.
- Both circuits are cryptographically identical twins (5-row difference),
  matching their indistinguishable proving times.
- The Zswap wrapper proof (~4.4–5.7 s, every transaction) proves separate
  input/output/signing sub-circuits per coin (SRS k=10–15); deploys balance
  more coins, hence constructor's larger Zswap time.

## Reproducing

```bash
# Run the bench (see README for stack setup)
BENCH_ENV=standalone BENCH_WALLET_SEED=<seed> BENCH_ITERATIONS=1 yarn bench

# Per-circuit constraint-system model
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update
~/.compact/versions/<ver>/<arch>/zkir mock-compile -v managed/counter/zkir/proveOwnership.zkir

# Server-side request durations
docker logs zk-bench-proof-server 2>&1 | grep took
```
