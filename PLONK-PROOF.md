## STEP 1

Statement being proved: "I know 32 secret bytes sk such that persistent_hash("assetOwner:pk": + sk) == assetOwner and assetExpired == False
 [bridge.compact:57-68](bridge.compact#L57-L68)

sk is the 32 byte secret key. This is a "witness", meaning its a private input only the prover knows. Never appears in the transaction or on-chain. 

Proves that **I hold the secret key behind this asset's recorded owner, and the asset hasn't expired**, without ever revealing the key itself.

## STEP 2

Compact compiler takes bridge.compact as source and produces everything under managed/counter like: 
```
managed/counter/
├── zkir/
│   ├── proveOwnership.zkir     ← circuit, text/JSON form
│   └── proveOwnership.bzkir    ← circuit, binary form (loaded by the prover)
├── contract/
│   └── index.cjs               ← JS/TS wrapper (witness glue: _publicKey_0, etc.)
├── keys/
│   ├── proveOwnership.prover   ← 5.5 MB PLONK proving key
│   └── proveOwnership.verifier ← 2.6 KB PLONK verifying key
└── compiler/
    └── contract-info.json      ← compiler metadata
```

**proveOwnership.zkir:** the circuit as text/JSON: 52 instructions expressed as constraints, what actually gets proven.

**proveOwnership.bzkir:** the same 52 instructions, binary-encoded.

**index.cjs:** Wrapper for the circuit, allows proveOwnership to be called as a normal JS function. [index.cjs:400](managed/counter/contract/index.cjs#L400). It pulls in the witness and ledger reads locally, compute the same hash / equality logic locally. Figures out what the actual values are, like what sk hash to and whats currently in assetOwner on the ledger, then these numbers get fed in as the witness 

**proveOwnership.prover:** everything the prover needs to turn a witness into a proof for this circuit, without it, no proof can be generated at all.

**proveOwnership.verifier:** embedded on-chain; what a node checks a submitted proof against, without it, nobody can verify a proof.

## STEP 3

Calling proveOwnership() triggers a chain of calls before any cryptography happens; this prepares the witness and packages it for the prover.
```
src/bench.test.ts:204 → api.proveOwnershipProofOnly()
        ↓
src/api.ts:198 → contract.callTx.proveOwnership()
        ↓
index.cjs → _proveOwnership_0 computes witness + ledger reads locally
        ↓
unproven transaction packaged, ready for the prover
```

**contract.callTx.proveOwnership():** [src/api.ts:198](src/api.ts#L198): the actual entry point; everything below is triggered by this one call.

**_proveOwnership_0 (index.cjs):** [index.cjs:400](managed/counter/contract/index.cjs#L400): the local JS computation from STEP 2: pulls in sk, computes the hash natively, reads assetOwner/assetExpired off the ledger, checks the statement holds, before any cryptography happens.

**unproven transaction:** the witness + claimed values packaged up and handed off to the prover. The actual proof generation happens in STEP 4.

## STEP 4

The circuit + prover key from STEP 2 get used to generate a proof, which anyone holding the verifier key can check.
```
zk-standalone/src/main.rs:193 → load the circuit (IrSource)
        ↓
:244 → preimage.check() re-validates the witness against the real constraints
        ↓
:265-276 → load/regenerate the prover key (pk) + verifier key (vk)
        ↓
:281 → ir.prove() → create_proof: the PLONK rounds (commit → lookup →
        grand products → quotient h(X) → evaluate → KZG opening)
        ↓
proof (4,480 bytes) + public statement (assetOwner, assetExpired, binding_input, ...)
        ↓
:305 → vk.verify(): one pairing check against proveOwnership.verifier
```

> Note: the actual code loads the **text `.zkir`**, not the binary `.bzkir` : `zk-standalone/README.md` describes it as loading `.bzkir` via `load_from_tagged`, but that doesn't match `main.rs`. Going with the real code below, not the README.

**1. Load the circuit** [zk-standalone/src/main.rs:192-198](zk-standalone/src/main.rs#L192-L198)
```rust
// 1. Load the compiled circuit
let ir = IrSource::load(std::fs::File::open(artifacts.join("zkir/proveOwnership.zkir"))?)?;
println!(
    "circuit loaded: {} ZKIR instructions, communications commitment: {}",
    ir.instructions.len(),
    ir.do_communications_commitment
);
```
Reads the 52 instructions from STEP 2 into memory as an `IrSource`, the in-memory form the prover will actually walk.

**2. preimage.check()** : [zk-standalone/src/main.rs:242-245](zk-standalone/src/main.rs#L242-L245)
```rust
// 3. Validate with the REAL preprocess (same code path the proof server runs)
let t = Instant::now();
preimage.check(&ir).map_err(|e| anyhow!("{e}"))?;
println!("witness check (real ZKIR preprocess): OK in {:?}", t.elapsed());
```
Re-runs the witness from STEP 3 through the real ZKIR `preprocess` pass, the same code path the proof server uses : catching any inconsistency before the expensive proving step. Measured at ~80-215 µs.
 :
**3. Load the keys** [zk-standalone/src/main.rs:264-276](zk-standalone/src/main.rs#L264-L276)
```rust
let t = Instant::now();
let (pk, vk) = ir.keygen(&provider).await.map_err(|e| anyhow!("{e}"))?;
println!("key pair regenerated at engine v0.7.1 in {:?}", t.elapsed());
let mut buf = Vec::new();
Serializable::serialize(&pk, &mut buf)?;
std::fs::write("keys/proveOwnership.pk", &buf)?;
let mut buf = Vec::new();
Serializable::serialize(&vk, &mut buf)?;
std::fs::write("keys/proveOwnership.vk", &buf)?;
```
Gets the `proveOwnership.prover`/`proveOwnership.verifier` pair from STEP 2 in-memory as `pk`/`vk`. (`zk-standalone` specifically regenerates these instead of reading the files directly : see [zk-standalone/README.md](zk-standalone/README.md#L26-L33) : but a real proof server just deserializes the `.prover`/`.verifier` files as-is.)

**4. ir.prove() → create_proof** : [zk-standalone/src/main.rs:278-291](zk-standalone/src/main.rs#L278-L291)
```rust
// 5. PROVE : the exact call chain of the proof server: Zkir::prove ->
//    midnight_zk_stdlib::prove -> midnight-proofs create_proof (KZG/BLS12-381/Blake2b)
let t = Instant::now();
let (proof, pis, _skips) = ir
    .prove(OsRng, &provider, pk, &preimage)
    .await
    .map_err(|e| anyhow!("{e}"))?;
let t_prove = t.elapsed();
println!(
    "PROVE:  {:?}  (proof = {} bytes, {} public inputs)",
    t_prove,
    proof.0.len(),
    pis.len()
);
```
Runs the actual PLONK rounds: commits the witness (hiding sk), proves the SHA-256 hash's gates and lookups are satisfied, folds everything into one small proof. Full round-by-round detail (with real source lines from `midnight-proofs`) is in [PLONK-PROVER-WALKTHROUGH.md](PLONK-PROVER-WALKTHROUGH.md). Measured at ~297 ms, producing a 4,480-byte proof over 21 public inputs.

**5. vk.verify()** : [zk-standalone/src/main.rs:302-307](zk-standalone/src/main.rs#L302-L307)
```rust
// 6. VERIFY : against the verifier key and the embedded verifier parameters
//    (transient-crypto's PARAMS_VERIFIER).
let t = Instant::now();
vk.verify(&PARAMS_VERIFIER, &proof, pis.iter().copied())
    .map_err(|e| anyhow!("{e}"))?;
println!("VERIFY: {:?}  -> proof ACCEPTED", t.elapsed());
```
Checks the proof against `proveOwnership.verifier` with one pairing equation on BLS12-381; accepts or rejects. Measured at ~8 ms, constant time regardless of circuit size.