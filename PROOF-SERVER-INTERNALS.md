# Proof Server Internals — What Actually Happens During `circuitProofMs`

This document traces the complete PLONK proving pipeline for this benchmark, from
`contract.callTx.proveOwnership()` in TypeScript down to the polynomial math inside the
`midnightnetwork/proof-server` Docker container. Every claim is backed by a file:line
reference that you can reproduce (see [Reproducing this analysis](#reproducing-this-analysis)).

**Source versions this document is pinned to:**

| Component | Version / ref |
|---|---|
| This repo's proof server image | `midnightnetwork/proof-server:4.0.0` ([standalone.yml](standalone.yml) line 4) |
| `midnightntwrk/midnight-ledger` (proof server source) | commit `272c25fcaabcd8f18951bd38a5dd7b0112e37d4a` (2026-08-07, workspace version 8.2.0-rc.1) |
| `midnight-proofs` (PLONK/Halo2 fork) | 0.7.1 (crates.io, from midnight-ledger `Cargo.lock`) |
| `midnight-circuits` (gadget stdlib) | 6.2.0 (crates.io) |
| Local SDK packages | see this repo's `yarn.lock` (`@midnight-ntwrk/*`) |

> Caveat: the pinned `midnight-ledger` commit is newer than the 4.0.0 image we run.
> HEAD adds a `/prove` endpoint and marks `/prove-tx` deprecated, plus "dust" circuits.
> The `/prove-tx` code path our client uses exists in both and is architecturally identical.
> Line numbers below are exact at the pinned commit.

---

## 0. Big picture

```
callTx.proveOwnership()                                  src/api.ts:198
 └─ 1. JS circuit execution (witness + transcript)       midnight-js-contracts index.mjs:321-347
 └─ 2. transcript partition → public inputs              index.mjs:307-315 (ledger WASM)
 └─ 3. UnprovenTransaction assembly                      index.mjs:283-289
 └─ 4. load {prover key, verifier key, zkir}             managed/counter/{keys,zkir}/
 └─ 5. POST /prove-tx (tx ++ Borsh{pk,vk,zkir})          http-client-proof-provider index.mjs:70-92
      └─ [proof server, Rust]
          6. deserialize + worker pool                   proof-server/src/endpoints.rs:328-382
          7. walk tx: contract calls + zswap coins       ledger/src/prove.rs:150-193, 252-375
          8. ZKIR pass 1: out-of-circuit witness run     zkir/src/ir_vm.rs (preprocess)
          9. ZKIR pass 2: constraint synthesis           zkir/src/ir_vm.rs:604-838
         10. PLONK prove (KZG / BLS12-381 / Blake2b FS)  zkir/src/ir.rs:118-138 → midnight_zk_stdlib::prove
 └─ 11. wallet.proveTransaction → same /prove-tx          walletProofMs (built-in zswap circuits)
 └─ 12. node verifies against on-chain verifier key
```

- `circuitProofMs` (this benchmark) = wall time of step 5–10 for the contract circuit.
- `walletProofMs` = the same machinery run a second time for the Zswap (shielded coin) proof.

---

## 1. Client side (this repo + node_modules)

### 1.1 Circuit execution is plain JavaScript, not proving

`submitCallTx` → `createUnprovenCallTx` → `call` in
`node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs:321-347`
executes the compiled circuit (`managed/counter/contract/index.cjs:87-109`) as ordinary JS.
This concrete run records everything the prover later needs:

- `proofData.input` / `output` — private circuit inputs/outputs
- `proofData.publicTranscript` — ordered public-state reads/writes
- `proofData.privateTranscriptOutputs` — values returned by witnesses
  (`src/witnesses.ts:9-29` supplies the secret keys from local private state)

`persistentHash` here is computed natively by the Rust→WASM runtime
(`@midnight-ntwrk/onchain-runtime/midnight_onchain_runtime_wasm_bg.wasm`).

### 1.2 The HTTP protocol

`node_modules/@midnight-ntwrk/midnight-js-http-client-proof-provider/dist/index.mjs`:

- line 48: path constant `/prove-tx`; line 56: 300 s timeout; lines 12-17: retry on 500/503.
- lines 23-46: payload = serialized `UnprovenTransaction` ++ Borsh-encoded map
  `{circuitId → (proverKey, verifierKey, zkir)}` — **the client uploads the 5.5 MB proving key
  with every request**.
- The payload contains witness secrets — this is why the proof server must be local/trusted
  (noted in the SDK source itself, lines 65-66).

### 1.3 The artifacts in `managed/counter/`

| File | What it is |
|---|---|
| `keys/proveOwnership.prover` (5.5 MB) | PLONK proving key: short version header + gzip stream (bytes 6-7 are `1f 8b`). Tag: `prover-key[v7](ir-source[v2])` |
| `keys/proveOwnership.verifier` (2.6 KB) | Verification key, embedded on-chain at deploy |
| `zkir/proveOwnership.zkir` | The circuit, as JSON: 52 instructions, ZKIR v2.0 |

### 1.4 The proveOwnership circuit is 52 ZKIR instructions

Dump it yourself (see §4). Semantics:

```
1-6    private_input ×3 + constrain_to_boolean + constrain_bits(8) + constrain_bits(248)
         = the Maybe<Bytes<32>> witness from assetOwnerSecretKey()
7      assert(is_some)                       "Asset Owner Secret Key not set"
18,25-27 public_input; test_eq(·, 0); assert  assetExpired == false
28     load_imm 0x61737365744F776E65723A706B3A   ← hex("assetOwner:pk:")
29     persistent_hash([Bytes<32>,Bytes<32>], [prefix, sk])
38-48  public_input ×2; test_eq ×2           hash == assetOwner
49-50  cond_select; assert                   "Not Owner"
51     output                                the `true` return
(19× declare_pub_input / 6× pi_skip bind transcript entries as PLONK public inputs)
```

The ZK statement: *"I know 32 secret bytes whose persistent_hash with prefix
`assetOwner:pk:` equals the public `assetOwner`, and public `assetExpired` = 0."*

---

## 2. Inside the proof server (midnight-ledger, Rust)

All paths below are relative to the `midnight-ledger` repo at the pinned commit.

### 2.1 Boot — `proof-server/src/main.rs`

- actix-web server on port 6300 (`main.rs:36`).
- **Worker pool: 2 workers by default** (`main.rs:44`, env `MIDNIGHT_PROOF_SERVER_NUM_WORKERS`),
  job timeout 600 s (`main.rs:48`), jobs run via `task::spawn_blocking`
  (`worker_pool.rs:236`). More than 2 concurrent proofs queue server-side.
- On startup (`main.rs:64-92`) it prefetches from `https://srs.midnight.network/`
  (URL: `base-crypto/src/data_provider.rs:69`, env `MIDNIGHT_PARAM_SOURCE`):
  - KZG public parameters (SRS) for circuit sizes k = 10..15 (`main.rs:78`), files named
    like `bls_midnight_2p14` — one per row-count 2^k;
  - built-in Zswap circuit keys `spend/output/sign` as `.prover/.verifier/.bzkir` triples
    (`zswap/src/structure.rs:60-88`, resolved in `zswap/src/prove.rs:34-77`).
- **This is the cold-start cost** measured in [TIMING-BREAKDOWN.md](TIMING-BREAKDOWN.md):
  first proof pays for downloads + key/SRS deserialization; afterwards they're cached.

### 2.2 `/prove-tx` handler — `proof-server/src/endpoints.rs:328-382`

1. `endpoints.rs:339-340` — deserializes the payload as
   `(Transaction<ProofPreimageMarker>, HashMap<String, ProvingKeyMaterial>)`
   — exactly what the JS client built in §1.2.
2. `endpoints.rs:348-361` — builds a key **resolver chain**:
   built-in zswap keys → dust keys → *the uploaded HashMap* (closure at line 358).
3. `endpoints.rs:362-366` — wraps it in `zkir_v2::LocalProvingProvider { rng: OsRng, … }`
   (`zkir/src/lib.rs:31-83`).
4. `endpoints.rs:370` — calls `tx.prove(provider, cost_model)`.

### 2.3 Walking the transaction — `ledger/src/prove.rs`

- `Transaction::prove` (`prove.rs:150-193`) proves **concurrently** (`futures::join!`):
  all intents (contract calls) + guaranteed coins + fallible coins (Zswap offers).
- `ContractCall::prove` (`prove.rs:252-375`):
  - line 259: `prover.check(preimage)` — dry-runs the ZKIR to find active transcript segments;
  - lines 263-344: rewrites transcripts, inserting `Noop` ops for inactive segments
    (and charging gas for them);
  - lines 355-364: computes the **binding input** from the transaction's Pedersen binding
    commitment (ties the proof to this transaction — no replay), then calls
    `prover.prove(preimage, binding_input)`.

### 2.4 The ZKIR virtual machine — two passes over the same 52 instructions

**Pass 1 — preprocess (out-of-circuit), `zkir/src/ir_vm.rs` (~214-500).**
Executes the instruction stream on a plain `Vec<Fr>` memory:
`private_input` pops the next witness value; `persistent_hash` computes SHA-256 natively
(`ir_vm.rs:410-424`); `pi_skip` validates expected vs computed public inputs
(`ir_vm.rs:425-451`); finally checks the communications commitment — a Poseidon commitment
over circuit inputs/outputs (`ir_vm.rs:488-499`).
Output: full memory trace + ordered public-input vector + skip info.

**Pass 2 — synthesize (in-circuit), `ir_vm.rs:604-838`.**
The same instructions now drive `midnight-circuits`' `ZkStdLib` gadgets in a Halo2-style
layouter, with pass 1's memory as assigned witnesses:

| ZKIR op | Gadget | Line (ir_vm.rs) |
|---|---|---|
| `assert` | `std.assert_non_zero` | 606 |
| `cond_select` | `std.select` (bit-converted) | 616-621 |
| `constrain_bits` | `std.assert_lower_than_fixed` range check | 630-635 |
| `constrain_to_boolean` | bit-conversion constraint | 639-642 |
| `declare_pub_input` | collect → `constrain_as_public_input` | 644-646, 836-838 |
| `transient_hash` | **Poseidon gadget** | 650-658 |
| `persistent_hash` | **full SHA-256 circuit gadget** (`std.sha2_256`) | 660-672 |
| `test_eq` | `std.is_equal` | 673-676 |
| `private_input` (guarded) | witness assign + (guard==0 ⇒ value==0) | 698-715 |
| EC ops / `hash_to_curve` | JubJub embedded-curve gadgets | 779-813 |

`used_chips()` (`ir_vm.rs:841-882`) enables only the chips the IR needs. For
`proveOwnership`: `sha2_256` (from `persistent_hash`) + `poseidon` (communications
commitment, re-proven in-circuit at `ir_vm.rs:816-834`).

> **Key cost insight:** Compact's `persistentHash` is proven as an **in-circuit SHA-256**.
> That single gadget dominates the constraint count of `proveOwnership`/`burnAsset`.
> A variant using `transientHash`/`transientCommit` (Poseidon) would be far cheaper
> in-circuit — a candidate follow-up experiment for [PLONK-COST-MODEL.md](PLONK-COST-MODEL.md).

### 2.5 The PLONK proof proper

`zkir/src/ir.rs:118-138` (`Zkir::prove` for `IrSource`):

1. `pk.init()?.k()` — circuit size k (rows = 2^k); at keygen it was
   `MidnightCircuit::from_relation(self).min_k()` (`transient-crypto/src/proofs.rs:182-183`).
2. `params.get_params(k)` — the cached KZG SRS for that size.
3. The uploaded `.prover` blob deserializes into the PLONK proving key
   (`ir.rs:145-167`, tag `prover-key[v7](ir-source[v2])`).
4. `ir.rs:136`: `midnight_zk_stdlib::prove::<_, TranscriptHash>(params, &pk, self, &pis, preproc, rng)`.

The proof system (`midnight-proofs` 0.7.1 + `midnight-circuits` 6.2.0, from the
[midnight-zk](https://github.com/midnightntwrk/midnight-zk) stack):

- **Halo2 fork with KZG polynomial commitments over BLS12-381**
  (`transient-crypto/src/proofs.rs:22-24,81` — `ParamsKZG<Bls12>`, `midnight_curves::Bls12`).
- **Fiat–Shamir transcript hash: Blake2b**
  (`proofs.rs:64` — `pub type TranscriptHash = blake2b_simd::State`).
- Standard PLONK flow: commit witness columns → permutation & lookup arguments (lookups are
  used by the SHA-256 chip) → evaluate at Blake2b-derived challenges → constant-size KZG
  opening proof. Runtime is dominated by multi-scalar multiplications ∝ 2^k.
  **This is `circuitProofMs`.**

### 2.6 Zswap proofs and the response

Coin offers in the same transaction (`prove.rs:158-174`) use the same machinery, but keys
resolve to the built-in `midnight/zswap/spend|output` circuits downloaded at boot — no
upload needed. This is also what `wallet.proveTransaction()` hits: the wallet engine
(Scala.js) has its own `ProverClient` POSTing to the same `/prove-tx`
(`@midnight-ntwrk/wallet/dist/main.js:13095`) — that's `walletProofMs`.

Each `ProofPreimageVersioned::V2` is replaced with a `ProofVersioned::V2`, the proven
transaction is re-serialized (`endpoints.rs:369-375`) and returned as the HTTP body.

### 2.7 Verification (for completeness)

The 2.6 KB verifier key is embedded into on-chain contract state at deploy
(`midnight-js-contracts/dist/index.mjs:254-262`). Nodes re-derive public inputs from the
transaction's transcript and run constant-time PLONK verification —
`midnight_zk_stdlib::verify` / `batch_verify` with the same Blake2b transcript
(`transient-crypto/src/proofs.rs:562,601`).

---

## 3. Benchmark-relevant consequences

1. **Concurrency ceiling:** default 2 proving workers server-side; benchmark runs with >2
   in-flight proofs measure queueing, not proving. Tune `MIDNIGHT_PROOF_SERVER_NUM_WORKERS`.
2. **Cold vs warm:** first proof pays SRS + built-in key download/deserialization
   (matches the 3-iteration data in [TIMING-BREAKDOWN.md](TIMING-BREAKDOWN.md)).
3. **Per-request overhead:** the 5.5 MB proving key is uploaded and deserialized on every
   `/prove-tx` call — part of `circuitProofMs` but not "pure PLONK math".
4. **Constraint budget:** dominated by the SHA-256 gadget from `persistentHash`.

---

## 4. Reproducing this analysis

### 4.1 Pin the proof server source

```bash
git clone https://github.com/midnightntwrk/midnight-ledger.git
cd midnight-ledger
git checkout 272c25fcaabcd8f18951bd38a5dd7b0112e37d4a
```

All `midnight-ledger` file:line references in §2 are exact at this commit. Key files:

```
proof-server/src/main.rs          # boot, worker pool args, SRS prefetch
proof-server/src/endpoints.rs     # /prove-tx handler (line 328)
proof-server/src/worker_pool.rs   # spawn_blocking job execution
ledger/src/prove.rs               # Transaction::prove, ContractCall::prove
zkir/src/lib.rs                   # LocalProvingProvider
zkir/src/ir.rs                    # Zkir::prove → midnight_zk_stdlib::prove
zkir/src/ir_vm.rs                 # the two-pass ZKIR virtual machine
transient-crypto/src/proofs.rs    # KZG params, ProverKey, Blake2b transcript
zswap/src/{structure,prove}.rs    # built-in zswap circuits
base-crypto/src/data_provider.rs  # srs.midnight.network fetching
```

Confirm the proof-system dependencies:

```bash
grep -A3 'name = "midnight-proofs"' Cargo.lock    # 0.7.1
grep -A3 'name = "midnight-circuits"' Cargo.lock  # 6.2.0
```

### 4.2 Inspect the local circuit artifacts (this repo)

Dump the proveOwnership circuit (52 instructions, ZKIR v2):

```bash
python3 -c "
import json
d = json.load(open('managed/counter/zkir/proveOwnership.zkir'))
print('version:', d['version'], 'instructions:', len(d['instructions']))
for i, ins in enumerate(d['instructions']):
    print(i, json.dumps(ins))
"
```

Confirm the prover key is a versioned header + gzip blob:

```bash
xxd managed/counter/keys/proveOwnership.prover | head -2
# bytes 6-7 = 1f 8b (gzip magic)
ls -la managed/counter/keys/
```

Decode the hash prefix constant from instruction 28:

```bash
python3 -c "print(bytes.fromhex('61737365744F776E65723A706B3A'))"  # b'assetOwner:pk:'
```

### 4.3 Inspect the SDK client code (this repo)

```bash
# HTTP protocol to the proof server
sed -n '1,95p' node_modules/@midnight-ntwrk/midnight-js-http-client-proof-provider/dist/index.mjs

# circuit call → unproven tx → proveTx flow
grep -n 'proveTx\|partitionTranscripts\|createUnprovenLedgerCallTx' \
  node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.mjs

# wallet's own prover client (Zswap proof, same endpoint)
grep -n '"/prove-tx"' node_modules/@midnight-ntwrk/wallet/dist/main.js
```

### 4.4 Poke the live proof server

```bash
docker compose -f standalone.yml up -d proof-server
curl http://127.0.0.1:6300/version         # 4.0.0
curl http://127.0.0.1:6300/ready           # worker pool status (jobs, capacity)
curl http://127.0.0.1:6300/proof-versions  # supported proof versions (V2)
```

Then run the benchmark as usual (`BENCH_WALLET_SEED=… yarn bench`) and correlate the
server's `docker logs zk-bench-proof-server` output with `[BENCH] proof-server call
starting/done` lines in this repo's logs.
