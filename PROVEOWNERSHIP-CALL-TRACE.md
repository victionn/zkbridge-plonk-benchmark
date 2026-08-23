# `proveOwnership` — Complete Call Trace, Line by Line, Back to Every Original Repo

One circuit, every hop. Starting from the benchmark's `contract.callTx.proveOwnership()`
and ending at the `blst` multi-scalar multiplications that produce the proof bytes. Each
hop names the **repo**, the **file**, the **exact lines**, and what they do.

### Sources this trace is pinned to

| Layer | Repo / package | Pinned ref | How to get it |
|---|---|---|---|
| Benchmark | this repo | `master` | — |
| SDK (JS) | `@midnight-ntwrk/*` in `node_modules/` | versions in `yarn.lock` | `yarn install` |
| Compiled circuit | `managed/counter/` | committed in this repo | Compact compiler output |
| Proof server + ZKIR VM | [midnightntwrk/midnight-ledger](https://github.com/midnightntwrk/midnight-ledger) | commit `272c25fcaabcd8f18951bd38a5dd7b0112e37d4a` | `git fetch --depth 1 origin 272c25fc…` |
| Circuit wrapper / prove API | `midnight-zk-stdlib` 1.2.0 ([midnight-zk](https://github.com/midnightntwrk/midnight-zk) `zk_stdlib/`) | sha256 `0bc88011…` | `static.crates.io` tarball |
| Gadget library (SHA-256 chip) | `midnight-circuits` 6.2.0 (midnight-zk `circuits/`) | sha256 `704fd24d…` | `static.crates.io` tarball |
| PLONK engine | `midnight-proofs` 0.7.1 (midnight-zk `proofs/`) | sha256 `b48f199f…` | `static.crates.io` tarball |

Download commands: PROOF-SERVER-INTERNALS.md §4.1 and §4.5. Browsable pinned mirrors of
the three crates: `https://docs.rs/crate/<crate>/<version>/source/<path>`.

Three layers, read top to bottom:

```
LAYER 1  JavaScript — this repo + SDK            hops 1–14   (builds the unproven tx, POSTs it)
LAYER 2  Rust — midnight-ledger (proof server)   hops 15–26  (interprets the circuit, calls the prover)
LAYER 3  Rust — midnight-zk crates               hops 27–40  (constraints → PLONK proof)
```

---

## LAYER 1 — JavaScript (this repo + `node_modules/@midnight-ntwrk/*`)

### Hop 1 — the benchmark call
**This repo · `src/api.ts:196-201`**
```ts
const proofDone = nextProofDone();
backgroundTask = contract.callTx.proveOwnership().catch(...)
const ms = await proofDone;
```
`callTx.proveOwnership` is a generated function (hop 2). `nextProofDone` (api.ts:176) is
the benchmark's hook that resolves when the proof-server call returns.

### Hop 2 — the `callTx` interface
**`@midnight-ntwrk/midnight-js-contracts` · `dist/index.mjs:612-616`** (wired at :924 by `findDeployedContract`, :803 by `deployContract`)
```js
const createCircuitCallTxInterface = (providers, contract, contractAddress, privateStateId) => {
    ...
        [circuitId]: (...args) => submitCallTx(providers, createCallTxOptions(contract, circuitId, contractAddress, privateStateId, args))
```
`circuitId` = `"proveOwnership"`.

### Hop 3 — `submitCallTx`
**midnight-js-contracts · `dist/index.mjs:456-483`**
```js
async function submitCallTx(providers, options) {
    ...
    const unprovenCallTxData = await createUnprovenCallTx(providers, options);   // hops 4–12
    const finalizedTxData = await submitTx(providers, {                          // hop 13
        unprovenTx: unprovenCallTxData.private.unprovenTx,
        newCoins: unprovenCallTxData.private.newCoins,
        circuitId: options.circuitId
    });
```

### Hop 4 — fetch the states the circuit runs against
**midnight-js-contracts · `dist/index.mjs:410-424` (`createUnprovenCallTx`) → `:154` (`getStates`)**
Loads the contract's on-chain state (via the indexer: `publicDataProvider.queryZSwapAndContractState`, :139)
and your private state (the secret key, from LevelDB via `privateStateProvider`).
Then calls `createUnprovenCallTxFromInitialStates` (:357).

### Hop 5 — execute the circuit (JavaScript, not proving)
**midnight-js-contracts · `dist/index.mjs:321-347` (`call`)**
```js
const circuit = contract.impureCircuits[circuitId];                      // :323
const initialTxContext = new QueryContext$1(initialContractState.data, contractAddress);  // :325
const { result, context, proofData } = circuit({                          // :326
    originalState: initialContractState,
    currentPrivateState: ...,
    transactionContext: initialTxContext,
    currentZswapLocalState: ...
}, ...args);
```
`proofData` will hold `input`, `output`, `publicTranscript`, `privateTranscriptOutputs`.

### Hop 6 — the generated circuit wrapper
**This repo · `managed/counter/contract/index.cjs:87-109`** (Compact compiler output)
```js
proveOwnership: (...args_1) => {
    ...
    const partialProofData = { input: {...}, output: undefined, publicTranscript: [], privateTranscriptOutputs: [] };  // :100-105
    const result_0 = this._proveOwnership_0(context, partialProofData);    // :106
    partialProofData.output = { value: _descriptor_0.toValue(result_0), alignment: _descriptor_0.alignment() };  // :107
    return { result: result_0, context: context, proofData: partialProofData };
```

### Hop 7 — the circuit body (mirrors `bridge.compact:57-68` line for line)
**This repo · `managed/counter/contract/index.cjs:400-435` (`_proveOwnership_0`)**

| index.cjs | does | bridge.compact |
|---|---|---|
| :401 | `this._assetOwnerSecretKey_0(context, partialProofData)` → hop 8 | :58 `const key = assetOwnerSecretKey();` |
| :402 | `__compactRuntime.assert(key_0.is_some, 'Asset Owner Secret Key not set')` | :60 |
| :403-416 | `Contract._query(... idx path [4] ... popeq)` reads ledger slot 4 (`assetExpired`) — **appends to `publicTranscript`** — then asserts `=== false` | :61 |
| :418-419 | `this._publicKey_0(key_0.value, <bytes "assetOwner:pk:" padded to 32>)` → hop 9 | :63 |
| :420-434 | `Contract._query(... idx path [7] ...)` reads slot 7 (`assetOwner`), asserts `_equal_0(owner_0, …)` `'Not Owner'` | :65 |
| :435 | `return true` | :67 |

### Hop 8 — the witness (the secret comes in here)
**`index.cjs:467-475` (`_assetOwnerSecretKey_0`) → this repo · `src/witnesses.ts:20-28`**
```ts
assetOwnerSecretKey: ({ privateState }) => [
    privateState,
    { is_some: true, value: privateState.assetOwnerSecretKey ?? new Uint8Array() },
],
```
The returned `Maybe<Bytes<32>>` is recorded into `privateTranscriptOutputs` — this is
what becomes the three `private_input` instructions in the ZKIR (hop 21).

### Hop 9 — `publicKey` = `persistentHash`
**`index.cjs:380-381` (`_publicKey_0`) → `:376-378` (`_persistentHash_0`)**
```js
_persistentHash_0(value_0) {
    const result_0 = __compactRuntime.persistentHash(_descriptor_3, value_0);
```
→ **`@midnight-ntwrk/compact-runtime` · `dist/runtime.js:148-149`**
```js
function persistentHash(rt_type, value) {
    const wrapped = ocrt.persistentHash(rt_type.alignment(), rt_type.toValue(value))[0];
```
→ `ocrt` = **`@midnight-ntwrk/onchain-runtime` · `midnight_onchain_runtime_wasm_bg.wasm`**,
compiled from **midnight-ledger · `onchain-runtime-wasm/`** — SHA-256 computed natively.
(This is the *out-of-circuit* value; the *in-circuit* SHA-256 happens at hop 33.)

### Hop 10 — partition the transcript → public inputs
**midnight-js-contracts · `dist/index.mjs:307-315` (`partitionTranscript`)**
```js
const partitionedTranscripts = partitionTranscripts([ new PreTranscript(..., publicTranscript) ], LedgerParameters.dummyParameters());
```
→ **`@midnight-ntwrk/ledger` (WASM)** ← built from **midnight-ledger · `ledger-wasm/src/transcript.rs:60-61`**
(`#[wasm_bindgen(js_name = "partitionTranscripts")]`) → **`ledger/src/construct.rs:1006`** (`partition_transcripts`).
Splits the transcript into guaranteed / fallible segments; these become the PLONK public inputs.

### Hop 11 — assemble the unproven transaction
**midnight-js-contracts · `dist/index.mjs:283-289` (`createUnprovenLedgerCallTx`)**
```js
new UnprovenTransaction(zswapStateToOffer(...), undefined,
    new ContractCallsPrototype().addCall(new ContractCallPrototype(
        contractAddress, circuitId, op, partitionedTranscript[0], partitionedTranscript[1],
        privateTranscriptOutputs, input, output, communicationCommitmentRandomness(), circuitId)));
```
All `UnprovenTransaction` / `ContractCallPrototype` classes are the `@midnight-ntwrk/ledger`
WASM (midnight-ledger `ledger-wasm/`). The call now carries a `ProofPreimage` — everything
needed to prove, minus the proof.

### Hop 12 — load your circuit artifacts
**midnight-js-contracts · `dist/index.mjs:437-438`**
```js
const proveTxConfig = options.circuitId ? { zkConfig: await providers.zkConfigProvider.get(options.circuitId) } : undefined;
```
→ **`@midnight-ntwrk/midnight-js-types` · `dist/index.mjs:81-86`** (`get`: bundles the three files)
→ **`@midnight-ntwrk/midnight-js-node-zk-config-provider` · `dist/index.mjs:45-63`**
```js
readFile(subDir, circuitId, ext) { return fs.readFile(path.join(this.directory, subDir, circuitId + ext)); }  // :45-46
getProverKey(circuitId)   { return this.readFile('keys', circuitId, '.prover') ... }                             // :51-52
getVerifierKey(circuitId) { ... '.verifier' }                                                                   // :57
getZKIR(circuitId)        { return this.readFile('zkir', circuitId, '.bzkir') ... }                              // :63
```
`this.directory` = `zkConfigPath` = **this repo · `src/config.ts:8`** → `managed/counter/`.
Files read: `keys/proveOwnership.prover` (5.5 MB), `keys/proveOwnership.verifier`, `zkir/proveOwnership.bzkir`.

### Hop 13 — `submitTx` → the proof-provider call
**midnight-js-contracts · `dist/index.mjs:440`**
```js
const unbalancedTx = await providers.proofProvider.proveTx(options.unprovenTx, proveTxConfig);
```
`providers.proofProvider` was built at **this repo · `src/api.ts:55`**
(`httpClientProofProvider(config.proofServer)`) and wrapped by the timing proxy at
**`src/providers.ts:41-64`** — `circuitProofMs` starts at :49 and stops at :53.

### Hop 14 — HTTP POST to the proof server
**`@midnight-ntwrk/midnight-js-http-client-proof-provider` · `dist/index.mjs:70-90`**
```js
const urlObject = new URL('/prove-tx', url);                                   // :72   → http://127.0.0.1:6300/prove-tx
async proveTx(unprovenTx, partialProveTxConfig) {
    const response = await fetchRetry(urlObject, {
        method: 'POST',
        body: await serializePayload(unprovenTx, config.zkConfig),             // :81  → tx bytes ++ Borsh{circuitId → pk, vk, zkir}  (:23-46)
        signal: AbortSignal.timeout(config.timeout)                            // :82  300 s
    });
    return deserializePayload(await response.arrayBuffer());                   // :89  ← proven tx comes back here
```

---

## LAYER 2 — Rust, proof server (`midnightntwrk/midnight-ledger` @ `272c25fc`)

### Hop 15 — route handler
**`proof-server/src/endpoints.rs:328-382`** ([GitHub](https://github.com/midnightntwrk/midnight-ledger/blob/272c25fcaabcd8f18951bd38a5dd7b0112e37d4a/proof-server/src/endpoints.rs#L328))
```rust
#[post("/prove-tx")]                                                                   // :328
let (tx, keys): TransactionProvePayload<Signature> = tagged_deserialize(&request[..])   // :339-340  ← your payload
pool.submit_and_subscribe(move || { ...                                                 // :341  worker pool (2 workers)
    let resolver = Resolver::new(PUBLIC_PARAMS.clone(), DustResolver(...),
        Box::new(move |loc| ... keys.get(loc.0.as_ref()).cloned() ...));                // :348-361  "proveOwnership" → your uploaded pk/vk/zkir
    let provider = zkir_v2::LocalProvingProvider { rng: OsRng, params: &resolver, resolver: &resolver };  // :362-366
    tx.prove(provider, &INITIAL_TRANSACTION_COST_MODEL.runtime_cost_model)              // :370  → hop 16
```

### Hop 16 — walk the transaction
**`ledger/src/prove.rs:150-193`** (`Transaction::prove`) → `:91` (`prove_intents`) → `:199` (`Intent::prove`) → `:234` (`ContractAction::prove`) → `:252` (`ContractCall::prove`).
Contract calls and Zswap coin proofs run concurrently (`futures::join!`, :166).

### Hop 17 — `ContractCall::prove`: check, then prove
**`ledger/src/prove.rs:252-375`**
```rust
let active_calls = match &self.proof { ProofPreimageVersioned::V2(proof) => prover.check(proof).await? };  // :259  → hop 18
... // :263-344  insert Noop ops for inactive transcript segments, recompute gas
prover.prove(preimage, Some(intermediate_call.binding_input(binding_commitment))).await?  // :355-364  → hop 19
```

### Hop 18 — `check`: dry-run the ZKIR
**`zkir/src/lib.rs:48-61`** (`LocalProvingProvider::check`)
```rust
let proving_data = self.resolver.resolve_key(preimage.key_location.clone()).await?...;   // :49-58
let ir = IrSource::load_from_tagged(Cursor::new(&proving_data.ir_source[..]))?;          // :59  parses proveOwnership.bzkir
preimage.check(&ir)                                                                      // :60
```
→ **`transient-crypto/src/proofs.rs:736`** (`ProofPreimage::check`) → **`zkir/src/ir.rs:111-116`** → `self.preprocess(preimage)?.pi_skips` (hop 21, first run).

### Hop 19 — `prove` entry
**`zkir/src/lib.rs:62-75`** (`LocalProvingProvider::prove`)
```rust
let mut preimage = preimage.clone();
if let Some(binding_input) = overwrite_binding_input { preimage.binding_input = binding_input; }   // :68-69
preimage.prove::<IrSource>(self.rng, self.params, self.resolver).await?.0                        // :71-74  → hop 20
```

### Hop 20 — load keys, prove, self-verify
**`transient-crypto/src/proofs.rs:742-772`** (`ProofPreimage::prove`)
```rust
let proof_data = resolver.resolve_key(self.key_location.clone()).await?...;                  // :748-754  your uploaded bundle
let ir = Z::load_ir_from_tagged(Cursor::new(&proof_data.ir_source[..]))?;                    // :755  → zkir/src/ir.rs:484 load_from_tagged
let verifier_key = tagged_deserialize::<VerifierKey>(&mut &proof_data.verifier_key[..])?;    // :756
let prover_key = Z::load_prover_key_from_tagged(Cursor::new(&proof_data.prover_key[..]))?;   // :757-758  → zkir/src/ir.rs:145-167 (gunzips the 5.5 MB key)
let (proof, pis, pi_skips) = ir.prove(rng, params, prover_key, self).await?;                 // :759  → hop 22
verifier_key.verify(&params.get_params(k).await?.as_verifier(), &proof, pis...)              // :761-769  self-check before returning
```

### Hop 21 — ZKIR pass 1: out-of-circuit witness run (`preprocess`)
**`zkir/src/ir_vm.rs:217-515`** — executes the 52 instructions over a `Vec<Fr>` memory.
Loop at `:298-301` (`for ins in self.instructions.iter() { match ins {`). Arms used by proveOwnership:

| ZKIR instr # | op | ir_vm.rs line | what it does in pass 1 |
|---|---|---|---|
| 0, 8, 11, 12, 19, 25, 28, 32, 40 | `load_imm` | :452 | push constant (incl. #28 = bytes of `"assetOwner:pk:"`) |
| 1, 3, 5 | `private_input` | :347-360 | pop next value from `private_transcript` (= your `sk` as is_some + 2 limbs) |
| 2 | `constrain_to_boolean` | :361 | check it's 0/1 |
| 4, 6 | `constrain_bits` (8, 248) | :362 | range-check the two limbs |
| 7, 27, 50 | `assert` | :323-327 | must be 1 ("key set", "not expired", "is owner") |
| 9, 13-16, 20-23, 30, 33-36, 41-45 | `declare_pub_input` | :343-346 | append to `pis` (transcript entries → public inputs) |
| 10, 17, 24, 31, 37, 46 | `pi_skip` | :425-451 | compare computed vs expected `public_transcript_inputs` |
| 18, 38, 39 | `public_input` | :329-342 | pop next value from public transcript (`assetExpired`, `assetOwner` halves) |
| 26, 47, 48 | `test_eq` | :328 | push (a == b) |
| 29 | `persistent_hash` | :410-424 | native SHA-256 of (prefix ‖ sk) → two field limbs |
| 49 | `cond_select` | :315-322 | combine equality bits |
| 51 | `output` | :453 | the `true` return |

Then `:488-499` checks the communications commitment (Poseidon over inputs/outputs).
Output: `Preprocessed { memory, pis, pi_skips, binding_input, comm_comm, … }`.

### Hop 22 — `Zkir::prove` for `IrSource`
**`zkir/src/ir.rs:118-138`**
```rust
use midnight_zk_stdlib::prove;                                                   // :125
let params_k = params.get_params(pk.init()?.k()).await?;                         // :127  KZG SRS for this k (bls_midnight_2p<k>)
let preproc = self.preprocess(preimage)?;                                        // :128  hop 21 again (the witness)
let pis = preproc.pis.clone();                                                   // :129
let pk = pk.init()...;                                                           // :132-134  → transient-crypto/src/proofs.rs:285 (deserialize PLONK pk)
let proof = prove::<_, TranscriptHash>(params_k.as_ref(), &pk, self, &pis, preproc, rng)?;   // :136  → LAYER 3
```
`TranscriptHash` = Blake2b (`transient-crypto/src/proofs.rs:64`). `get_params` = `:60-67` (SRS cache / download from srs.midnight.network).

---

## LAYER 3 — Rust, the PLONK engine (`midnightntwrk/midnight-zk`, pinned crate versions)

### Hop 23 — `prove()` wraps the relation
**`midnight-zk-stdlib` 1.2.0 · `src/lib.rs:1745-1773`** ([docs.rs](https://docs.rs/crate/midnight-zk-stdlib/1.2.0/source/src/lib.rs))
```rust
let pi = R::format_instance(instance)?;                                          // :1757  → zkir/src/ir_vm.rs:521
let circuit = MidnightCircuit::new(relation, Value::known(instance.clone()), Value::known(witness), Some(pk.max_bit_len));  // :1759-1764  → :1245
BlstPLONK::<MidnightCircuit<R>>::prove::<H>(params, &pk.pk, &circuit, 1, &[com_inst.as_slice(), &pi], rng)   // :1765-1772
```

### Hop 24 — PLONK facade
**midnight-zk-stdlib · `src/utils/plonk_api.rs:88-129`**
```rust
let mut transcript = CircuitTranscript::init();                                  // :104  Blake2b transcript
create_proof::<F, KZGCommitmentScheme<Bls12>, CircuitTranscript<H>, Relation>(params, pk, &[circuit.clone()], 1, &[pi], rng, &mut transcript)?;   // :105-117  → hop 25
transcript.finalize()                                                            // :119  ← THE PROOF BYTES
```

### Hop 25 — `create_proof`
**`midnight-proofs` 0.7.1 · `src/plonk/prover.rs:348-395`** ([docs.rs](https://docs.rs/crate/midnight-proofs/0.7.1/source/src/plonk/prover.rs))
```rust
let trace = compute_trace(...)      // :372  → hop 26 (synthesis + rounds 0-4 of PLONK) = prover.rs:57-235
finalise_proof(..., trace, ...)     // :382  → rounds 4b-6 = prover.rs:242-339
```

### Hop 26 — synthesis: the circuit is built *inside* the prover
**midnight-proofs · `src/plonk/prover.rs:99-105`** → `parse_advices` (`:461`) → calls the Halo2 `Circuit::synthesize` of `MidnightCircuit`:

**midnight-zk-stdlib · `src/lib.rs:1606-1660`**
```rust
impl<R: Relation> Circuit<F> for MidnightCircuit<'_, R> {                        // :1606
    fn configure(meta) -> Config { ZkStdLib::configure(meta, arch) }             // :1622-1628 → :387  allocates columns/gates per ZkStdLibArch
    fn synthesize(&self, config, layouter) {                                     // :1630
        let zk_std_lib = ZkStdLib::new(&config, self.max_bit_len as usize);      // :1635 → :308  instantiates chips (incl. Sha256Chip, :316)
        self.relation.circuit(&zk_std_lib, layouter, instance, witness)          // :1637 → hop 27
```
Which chips exist is decided by `used_chips()` — **midnight-ledger `zkir/src/ir_vm.rs:841-882`**:
for proveOwnership → `sha2_256: true` (because of `persistent_hash`), `poseidon: true` (communications commitment), `jubjub: false`.

### Hop 27 — ZKIR pass 2: in-circuit synthesis
**midnight-ledger · `zkir/src/ir_vm.rs:516-839`** (`impl Relation for IrSource`, `fn circuit` at `:527`).
Loop at `:604-605`. Each instruction becomes constraint gadgets via `ZkStdLib` (**midnight-circuits** underneath):

| ZKIR op | ir_vm.rs | gadget called | gadget source |
|---|---|---|---|
| `load_imm` | :648 | `std.assign_fixed` | midnight-circuits `src/field/native_gadget.rs` |
| `private_input` / `public_input` | :698-715 | `std.assign` + guard constraint | same |
| `constrain_to_boolean` | :639-642 | `std.convert` → `AssignedBit` | same |
| `constrain_bits` | :630-635 | `std.assert_lower_than_fixed` | midnight-circuits `src/field/decomposition/` (pow2 range table) |
| `assert` | :606 | `std.assert_non_zero` | native gadget |
| `declare_pub_input` | :644-646 → :836-838 | `std.constrain_as_public_input` | native gadget |
| `test_eq` | :673-676 | `std.is_equal` | native gadget |
| `cond_select` | :616-621 | `std.select` | native gadget |
| **`persistent_hash`** | **:660-672** | `fab_decode_to_bytes` → **`std.sha2_256`** → `assemble_bytes` | **hop 28** |
| `output` | :649 | (collect) | — |
| communications commitment | :816-834 | `std.poseidon` + `assert_equal` to public input #1 | midnight-circuits `src/hash/poseidon/poseidon_chip.rs` |

### Hop 28 — the in-circuit SHA-256 (the bulk of your constraints)
**midnight-zk-stdlib · `src/lib.rs:735-745`** (`ZkStdLib::sha2_256`) → `self.sha2_256_chip...hash(layouter, input)`
→ **midnight-circuits 6.2.0 · `src/hash/sha256/mod.rs:45`** (`impl HashInstructions<…> for Sha256Chip`)
→ **`src/hash/sha256/sha256_chip.rs`**: `sha256()` `:558`, `message_schedule()` `:625`, `compression_round()` `:661`;
columns/gates/lookup table configured in `configure()` `:166` (spread table `(n, X, ~X)`, 2 parallel lookups — file header :27-46).
([docs.rs](https://docs.rs/crate/midnight-circuits/6.2.0/source/src/hash/sha256/sha256_chip.rs))

**At this point the constraint system for proveOwnership exists in memory: columns filled with witness values, gates, copy constraints, lookup table. Hops 29–40 are pure PLONK.**

### Hops 29–40 — the PLONK rounds (midnight-proofs 0.7.1)

| Hop | Round | File : lines | What |
|---|---|---|---|
| 29 | 0 | `src/plonk/prover.rs:99-103` | hash vk + public inputs into Blake2b transcript |
| 30 | 1 | `src/plonk/prover.rs:461-593` (commit at :573) | blind + **commit advice columns** (MSM each) |
| 31 | 2 | `prover.rs:108` ; `src/plonk/lookup/prover.rs:58-150` | θ; compress + sort SHA-256 spread-table lookups, commit A′/S′ |
| 32 | 3a | `prover.rs:138-161` ; `src/plonk/permutation/prover.rs:36-161` | β, γ; **permutation grand product** (every reused ZKIR var) |
| 33 | 3b | `prover.rs:163-172` ; `src/plonk/lookup/prover.rs:155-260` | lookup grand product |
| 34 | 3c | `prover.rs:175-199` ; `src/plonk/trash/prover.rs` | trash argument (fork addition) |
| 35 | 4 | `prover.rs:202-205` ; `src/plonk/vanishing/prover.rs:37-81` | random blinder; y |
| 36 | 4 | `prover.rs:267, 596-651` ; `src/plonk/evaluation.rs:284` | **quotient**: evaluate all constraints (`evaluate_h`) |
| 37 | 4 | `src/plonk/vanishing/prover.rs:86-135` | divide by Xⁿ−1, split, blind, commit h pieces |
| 38 | 5 | `prover.rs:282-324, 657-715` | x; evaluations of every polynomial |
| 39 | 6 | `prover.rs:326-338` → `src/poly/kzg/mod.rs:100-188` | multipoint opening, final π |
| 40 | all | `src/poly/kzg/msm.rs:111-125` → `midnight-curves` 0.2.0 → `blst` | every commit = MSM on BLS12-381 |

Round-by-round code + worked example: PLONK-PROVER-WALKTHROUGH.md.

---

## The way back (for completeness)

| Hop | Where | What |
|---|---|---|
| 41 | `transient-crypto/src/proofs.rs:761-769` | proof server **self-verifies** the proof with your `.verifier` key before returning |
| 42 | `ledger/src/prove.rs:355-374` | `ProofVersioned::V2(proof)` attached to the `ContractCall` |
| 43 | `proof-server/src/endpoints.rs:369-375` | proven tx serialized → HTTP 200 body |
| 44 | http-client-proof-provider `dist/index.mjs:89` | JS deserializes → `UnbalancedTransaction` (timing proxy stops: `providers.ts:53`) |
| 45 | midnight-js-contracts `dist/index.mjs:441-443` | `balanceTx` (wallet Zswap proof → same `/prove-tx`) → `submitTx` → node |
| 46 | Midnight node (`midnight-node`, via `midnight-ledger` `transient-crypto/src/proofs.rs:601` `batch_verify`) | verifies against the on-chain verifier key; one pairing |

---

## Reading guide

- **"Where is my circuit?"** — hop 7 (readable), hop 21 table (ZKIR), hop 27 table (constraints).
- **"Where does my secret key go?"** — hop 8 → `privateTranscriptOutputs` → hop 14 payload → hop 21 `private_input` (:347) → hop 27 `std.assign` (:698) → blinded advice column, hop 30. It never leaves `127.0.0.1`.
- **"Where is `circuitProofMs` spent?"** — hops 14–44 wall-clock; compute is hops 28–40, dominated by hop 28's row count × hop 40's MSMs.
- **"What is PLONK vs what is Midnight?"** — hops 29–40 are textbook PLONK (plus hop 34); hops 15–28 are Midnight's runtime that turns Compact into a PLONK circuit.
