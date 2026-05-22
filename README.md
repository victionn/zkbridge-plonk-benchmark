# zk-bench

Standalone PLONK proof generation benchmark for the **Cardano–Midnight ZK Bridge** circuits.

## What it measures

Every `callTx.*` call on the Midnight side involves **two separate proof generations**. This benchmark captures both:

| Column | What it measures |
|---|---|
| `circuitProofMs` | HTTP call to proof-server `:6300` — pure PLONK work for your Compact circuit |
| `walletProofMs` | `wallet.proveTransaction()` inside the Midnight SDK — Zswap transaction proof |
| `totalCallTxMs` | Full round-trip: tx building → proof → submit → **block confirmation** |

Three circuits are benchmarked:

| Circuit | Who | What |
|---|---|---|
| `constructor` | Operator | Deploys a new zkAsset contract, validates operator key |
| `proveOwnership` | User | Proves asset ownership without revealing secret key |
| `burnAsset` | Operator | Marks a zkAsset as expired |

## Prerequisites

### 1. Proof server (required)

The proof server runs as a local Docker container and performs the actual PLONK computation.

```bash
# From the original bridge repo
docker compose -f bridge-cli/proof-server-testnet.yml up -d
```

Verify it's up:
```bash
curl http://127.0.0.1:6300/health
```

### 2. Midnight testnet wallet with tDUST

You need a funded Midnight testnet wallet to submit transactions.

Get tDUST from the faucet: https://docs.midnight.network/develop/tutorial/using/faucet

Set your wallet seed:
```bash
export BENCH_WALLET_SEED=<your_64_char_hex_seed>
```

### 3. Install dependencies

```bash
yarn install
```

## Running the benchmark

```bash
# Default: 3 iterations per circuit, testnet-remote
BENCH_WALLET_SEED=<seed> yarn bench

# More iterations for better statistics
BENCH_WALLET_SEED=<seed> BENCH_ITERATIONS=5 yarn bench

# Against a local standalone Docker stack (all services local)
BENCH_WALLET_SEED=<seed> BENCH_ENV=standalone yarn bench

# Verbose logs to debug
BENCH_WALLET_SEED=<seed> DEBUG_LEVEL=debug yarn bench
```

Logs are saved to `logs/bench-<timestamp>.log`.

## Understanding the output

After all iterations complete, a summary table prints to stdout:

```
═══════════════════════════════════════════════════════════════════
  ZK PROOF GENERATION BENCHMARK RESULTS
═══════════════════════════════════════════════════════════════════
  circuitProofMs  = pure PLONK time (HTTP call to proof-server :6300)
  walletProofMs   = Zswap tx proof inside Midnight wallet SDK
  totalCallTxMs   = full callTx round-trip incl. block confirmation

  ▶ CONSTRUCTOR  (n=3)
  ┌────────────────┬────────┬────────┬────────┬────────┬──────┬──────┐
  │                │ count  │  mean  │  min   │  max   │ p50  │ p90  │
  ├────────────────┼────────┼────────┼────────┼────────┼──────┼──────┤
  │ circuitProofMs │   3    │ 4200.0 │ 4050.0 │ 4380.0 │ ...  │ ...  │
  │ walletProofMs  │   3    │  320.0 │  310.0 │  335.0 │ ...  │ ...  │
  │ totalCallTxMs  │   3    │ 28000  │ 26000  │ 30000  │ ...  │ ...  │
  └────────────────┴────────┴────────┴────────┴────────┴──────┴──────┘
```

The `totalCallTxMs` will be much larger than `circuitProofMs + walletProofMs` because it includes waiting for the transaction to be included in a block (~20-60s on testnet).

## Project layout

```
zk-bench/
├── src/
│   ├── bench.test.ts     — vitest benchmark suite (3 circuit suites)
│   ├── api.ts            — Midnight API calls with timing wrappers
│   ├── providers.ts      — timed proof provider + wallet provider
│   ├── timings.ts        — shared timing store + stats/print helpers
│   ├── config.ts         — testnet-remote / standalone configs
│   ├── witnesses.ts      — ZK witness functions (private key providers)
│   ├── common-types.ts   — TypeScript type aliases
│   └── logger-utils.ts   — pino logger setup
├── managed/
│   └── counter/
│       ├── compiler/
│       │   └── contract-info.json   — circuit metadata (3 circuits)
│       └── contract/
│           └── index.cjs            — compiled Compact contract (53KB)
├── vitest.config.ts
├── vitest.setup.ts       — protobuf Long setup required by Midnight SDK
├── tsconfig.json
└── package.json
```
