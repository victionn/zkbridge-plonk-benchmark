# zk-standalone — proveOwnership PLONK prove + verify in one process

Self-contained replacement for the Docker proof server + HTTP hop: one Rust binary that
loads the compiled `proveOwnership` circuit and keys from `../managed/counter`, generates
a valid witness, runs the **real PLONK prover**, and verifies the proof — all in-process.

```
cargo run --release            # uses ../managed/counter by default
cargo run --release -- <dir>   # explicit artifacts dir
```

## What it does (mirrors the proof server's exact code path)

1. **Load circuit** — `IrSource::load_from_tagged` on `zkir/proveOwnership.bzkir`
   (52 ZKIR instructions).
2. **Generate witness in Rust** — picks a random secret key (as the Compact encoding's
   8-bit + 248-bit limbs), then interprets the ZKIR to build the three transcript streams
   of a `ProofPreimage`:
   - `private_transcript` = `[is_some=1, sk_lo, sk_hi]`
   - `public_transcript_outputs` = the "ledger reads": `assetExpired = false`, and
     `assetOwner` = the two output limbs of the in-program
     `persistent_hash("assetOwner:pk:" ++ sk)` — i.e. the stored owner really is the
     hash of our key, exactly like a real deployment.
   - `public_transcript_inputs` = the 19 `declare_pub_input` values.
   The interpreter is a faithful copy of the generation-relevant arms of
   `midnight-ledger/zkir/src/ir_vm.rs::preprocess` (commit `272c25fc`).
3. **Validate** — `ProofPreimage::check` runs the *real* `preprocess` over the witness.
4. **Keys** — the `.prover`/`.verifier` files in `managed/counter` are in the legacy
   container format of proof-server 4.0.0 (u16 version + u32 length + gzip, wrapping
   pre-tag serialization) which the current published crates cannot parse. So the key
   pair is **regenerated from the same IR** with the pinned engine (`Zkir::keygen`,
   ~3 s) and cached in `./keys/`. The circuit is byte-identical (it is the IR loaded in
   step 1); only the key encoding is fresh. Note: engine 0.7.1 fits the circuit in
   **k = 13** (2^13 rows) vs k≈14 for the 4.0.0-era keys.
5. **Prove** — `Zkir::prove` → `midnight_zk_stdlib::prove` → `midnight-proofs`
   `create_proof` (PLONK over KZG/BLS12-381, Blake2b Fiat–Shamir, blst MSMs).
6. **Verify** — `VerifierKey::verify` with the verifier parameters embedded in
   `transient-crypto` (`PARAMS_VERIFIER`).
7. **Negative tests** — flips one byte of the proof, and separately perturbs one public
   input; both must be rejected.

## Measured on an Apple-silicon MacBook (this repo's benchmark machine)

```
witness check (real ZKIR preprocess): OK in ~80-215 µs
key pair regenerated at engine v0.7.1 in 3.18 s   (first run only, then cached)
prover key ready (k = 13, rows = 2^13)
PROVE:  ~297 ms   (proof = 4480 bytes, 21 public inputs)
VERIFY: ~8 ms  -> proof ACCEPTED
tampered proof:      correctly REJECTED
tampered statement:  correctly REJECTED
```

Compare with the benchmark's `circuitProofMs` (~seconds through the Docker container):
the difference is the HTTP hop, the per-request 5.5 MB key upload + deserialization,
the container's worker queue, the k=14→13 row-count drop, and the server's self-verify.

## Dependencies (pinned to the versions analyzed in the repo docs)

| Crate | Version | Role |
|---|---|---|
| `midnight-zkir` | =2.1.0 | ZKIR interpreter (witness pass + circuit synthesis) |
| `midnight-transient-crypto` | =2.1.0 | ProofPreimage, keys, params, Zkir trait |
| `midnight-proofs` | =0.7.1 | the PLONK engine (Halo2 fork, KZG/BLS12-381) |
| `midnight-circuits` | =6.2.0 | gadgets (SHA-256 spread-table chip, Poseidon) |
| `midnight-zk-stdlib` | =1.2.0 | MidnightCircuit wrapper, prove/verify API |

These are the same published crates the `midnightnetwork/proof-server` image is built
from (see ../PROOF-SERVER-INTERNALS.md for checksums and the full analysis).

## Network access

Exactly one download, on first run: the KZG SRS file for the circuit's k
(`bls_midnight_2p<k>`) from `https://srs.midnight.network/` into `./params/`
(override the cache dir with `MIDNIGHT_PP`, the source URL with
`MIDNIGHT_PARAM_SOURCE`). Every subsequent run is fully offline. Verification uses
verifier parameters embedded in the `midnight-transient-crypto` crate — no download.

## What's intentionally different from the benchmark's `circuitProofMs`

This measures **pure prove + verify**: no HTTP round-trip, no per-request upload and
deserialization of the 5.5 MB proving key, no proof-server worker queue, and no wallet
(Zswap) proof. Expect the prove time here to be somewhat lower than `circuitProofMs`
from `yarn bench`; the difference is the server/transport overhead.

## Relation to the docs

- Call path this reproduces: hops 18–41 of ../PROVEOWNERSHIP-CALL-TRACE.md
- The PLONK rounds executed inside `prove`: ../PLONK-PROVER-WALKTHROUGH.md
- Beginner explanation: ../PROVEOWNERSHIP-FOR-BEGINNERS.md
