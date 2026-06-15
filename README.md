
# to run

docker compose -f C:\Users\jinta\Desktop\zk-bench\standalone.yml up -d
Start-Sleep -Seconds 10
$env:BENCH_ENV = "standalone"
$env:BENCH_WALLET_SEED = "0000000000000000000000000000000000000000000000000000000000000001"
$env:BENCH_ITERATIONS = "1"

Remove-Item -Recurse -Force C:\Users\jinta\Desktop\zk-bench\midnight-level-db
yarn bench

## Architecture
 
The benchmark runs against a local Docker stack consisting of three services:
 
```
┌─────────────────────────────────────────────────┐
│                  zk-bench (host)                │
│   TypeScript test harness (bench.test.ts)       │
│   Submits transactions, records timings          │
└────────────┬────────────────────────────────────┘
             │ localhost
    ┌────────▼──────────┐
    │   proof-server    │  midnightnetwork/proof-server:4.0.0
    │   port 6300       │  BLS12-381 / KZG polynomial commitment
    │   (Halo2 prover)  │  Handles both circuit proofs and Zswap proofs
    └────────┬──────────┘
             │
    ┌────────▼──────────┐
    │  standalone node  │  Midnight dev node (single-validator)
    │  (block producer) │  Block interval: ~15–20s (dev preset)
    └────────┬──────────┘
             │
    ┌────────▼──────────┐
    │     indexer       │  midnightnetwork/indexer-standalone:2.1.1
    │  (chain indexer)  │  Tracks contract state and events
    └───────────────────┘
```
 
All proving runs fully locally. The `proof-server` container at `localhost:6300` handles all cryptographic computation — both PLONK circuit proving and Zswap wallet proving.
 
---
 
## Circuit Source
 
The three circuits originate from `bridge.compact`, compiled using **Compact 0.25.0** inside WSL. Compiled circuit artifacts (proving keys, verifying keys, ZKIR files) are stored under `managed/counter/` — the `counter` directory name is a legacy scaffold artifact and does not reflect the circuit contents.
 
The two key files per operation:
- `*.pk` — prover key (loaded into the proof-server for witness computation)
- `*.zkir` — ZK intermediate representation (circuit constraint system)
Approximate prover key sizes:
- `constructor`: trivial (cache-hit fast, ~45ms circuit proof)
- `proveOwnership`: ~5.52 MB
- `burnAsset`: ~5.52 MB
The near-identical key sizes for `proveOwnership` and `burnAsset` indicate they share the same Halo2 circuit size parameter `k` (approximately `k=14`, ~9,683–9,686 constraint rows).
 
---
 
## What Gets Measured
 
The harness captures three timing metrics per operation:
 
### 1. `circuitProofMs` — PLONK circuit proof time
 
The time taken by the `proof-server` to generate a PLONK proof for a single circuit operation. Measured from the moment the prover receives the witness inputs to when the proof is returned.
 
- For `constructor`: ~45ms (trivial witness; benefits from proof-server key cache on iterations after the first)
- For `proveOwnership` and `burnAsset`: ~2,400ms each (full witness computation over ~9,684 constraint rows)
This is the primary variable of interest — it reflects the irreducible cryptographic cost of each bridge circuit, independent of network or block confirmation overhead.
 
### 2. `walletProofMs` — Zswap transaction wrapper proof time
 
The time taken to generate the Zswap proof that wraps the circuit proof into a shielded Midnight transaction. Required by the Midnight ledger for all shielded transaction submissions. Also computed inside the `proof-server` container at `localhost:6300`.
 
- Consistent across all three operations: ~6.7–6.8s
- This is the dominant local proving cost and represents a fixed overhead regardless of which bridge circuit is being exercised
> **Known bug**: The bench's built-in summary tables incorrectly record `walletProofMs` as zero for `proveOwnership` and `burnAsset`. Real timings must be extracted from raw NDJSON logs by searching for `wallet.proveTransaction done` lines.
 
### 3. `totalCallTxMs` — end-to-end transaction time (constructor only)
 
The wall-clock time from transaction submission to confirmed on-chain settlement. Captures everything: circuit proof, wallet proof, transaction propagation, mempool wait, and block confirmation.
 
- For `constructor`: ~25–50s
- Dominated by block confirmation time (~15–20s per block at dev-node cadence), not cryptographic proving
`totalCallTxMs` is not measured for `proveOwnership` and `burnAsset` because their `callTx` calls are dispatched as background tasks without awaiting on-chain confirmation (to avoid the indexer crash described below).
 
---
 
## Step-by-Step Execution Flow
 
For each benchmark iteration, the harness performs the following steps:
 
### Phase 0 — Environment setup (before any iteration)
 
1. Docker stack started: `proof-server`, `standalone-node`, `indexer-standalone`
2. Proof-server loads circuit proving keys from `managed/counter/` into memory
3. Standalone node begins producing blocks at dev cadence (~15–20s intervals)
4. Genesis wallet (seed `0000...0001`) is loaded — pre-funded with `tDUST` on the standalone dev node
5. Harness connects to the indexer and waits for chain sync
### Phase 1 — `constructor` operation
 
1. Harness calls `contract.deploy()` — deploys the bridge contract to the standalone node
2. Witness inputs computed locally (operator secret key, derived public key via `persistentHash`)
3. **`circuitProofMs` starts** — PLONK proof request sent to `proof-server:6300`
4. `proof-server` loads the constructor proving key (or serves from cache on repeat runs)
5. Halo2 prover computes the PLONK proof over the constructor circuit constraints
6. **`circuitProofMs` ends** — proof returned to harness
7. **`walletProofMs` starts** — Zswap wrapper proof requested from `proof-server:6300`
8. `proof-server` generates the Groth16/Zswap transaction envelope proof
9. **`walletProofMs` ends** — wrapped transaction ready
10. **`totalCallTxMs` starts** — transaction submitted to standalone node
11. Node validates proof, includes in next block (~15–20s wait)
12. Indexer confirms on-chain state update
13. **`totalCallTxMs` ends** — settlement confirmed
### Phase 2 — `proveOwnership` operation
 
1. Harness calls `contract.callTx.proveOwnership()` against the deployed contract
2. Witness inputs computed locally (owner secret key, stored `assetOwner` commitment)
3. **`circuitProofMs` starts** — PLONK proof request sent to `proof-server:6300`
4. `proof-server` loads the `proveOwnership` proving key (~5.52 MB)
5. Halo2 prover computes PLONK proof over ~9,684 constraint rows
6. **`circuitProofMs` ends** — proof returned (~2,400ms)
7. **`walletProofMs` starts** — Zswap wrapper proof requested
8. `proof-server` generates Zswap transaction envelope proof
9. **`walletProofMs` ends** — wrapped transaction ready (~6.7–6.8s)
10. `callTx` dispatched as background task (not awaited for on-chain confirmation)
11. `waitForBackgroundTasks()` called to drain the background promise before next iteration
> Background dispatch is intentional: awaiting on-chain confirmation for this operation during repeated iterations caused concurrent LevelDB access failures in the indexer.
 
### Phase 3 — `burnAsset` operation
 
Follows the same flow as `proveOwnership`:
 
1. Harness calls `contract.callTx.burnAsset()` against the deployed contract
2. Witness inputs computed locally (operator secret key, asset identifier)
3. **`circuitProofMs` starts** — PLONK proof request sent to `proof-server:6300`
4. `proof-server` loads the `burnAsset` proving key (~5.52 MB)
5. Halo2 prover computes PLONK proof over ~9,684 constraint rows
6. **`circuitProofMs` ends** — proof returned (~2,400ms)
7. **`walletProofMs` starts** — Zswap wrapper proof requested
8. `proof-server` generates Zswap transaction envelope proof
9. **`walletProofMs` ends** — wrapped transaction ready (~6.7–6.8s)
10. `callTx` dispatched as background task (not awaited)
11. `waitForBackgroundTasks()` called to drain before next iteration
### Phase 4 — Logging
 
After each full iteration (all three operations), timing results are written to stdout as **NDJSON** (newline-delimited JSON). One JSON object per operation per iteration, containing:
 
```json
{
  "operation": "proveOwnership",
  "iteration": 1,
  "circuitProofMs": 2431,
  "walletProofMs": 6784,
  "totalCallTxMs": null
}
```
 
Logs are captured by the PowerShell collection loop and written to `logs/run-XX.ndjson`.
 
---
 
## Known Limitations
 
**Indexer crash at block ~49**: The `indexer-standalone:2.1.1` image crashes with `assertion failed: node_block_height >= block.height` at approximately block 49 (~270s of runtime). This limits each Docker session to `BENCH_ITERATIONS=1`. The workaround is to restart the full Docker stack between every run.
 
**`walletProofMs` bug in built-in summary**: The bench's built-in summary tables record `walletProofMs` as zero for `proveOwnership` and `burnAsset`. This is a bench-level bug. True `walletProofMs` values must be extracted from raw log lines matching `wallet.proveTransaction done`.
 
**Dev-node block time is not mainnet**: The ~15–20s block confirmation time in `totalCallTxMs` reflects the standalone dev-node configuration preset, not Midnight mainnet or Cardano mainnet behaviour. Block time on Midnight is targeted at ~6s; Cardano is ~20s with probabilistic finality. The `totalCallTxMs` figures are not representative of production settlement latency.
 
**No scaling curve across circuit sizes**: `proveOwnership` and `burnAsset` have near-identical proving key sizes (~5.52 MB, `k≈14`). A PLONK proof time scaling curve (time vs. constraint count) cannot be derived from only two equally-sized circuits. Circuits of meaningfully different sizes would be required.
 
**Proof-only measurement for two operations**: `proveOwnership` and `burnAsset` are measured proof-only (no on-chain confirmation awaited), so no genuine end-to-end latency figure is available for those operations.
 
---