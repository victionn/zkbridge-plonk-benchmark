//! Standalone PLONK prove + verify for the `proveOwnership` circuit.
//!
//! Replaces the Docker proof server + HTTP hop with a single process:
//!   1. loads the compiled circuit (`proveOwnership.zkir`) from ../managed/counter
//!   2. generates a valid witness in Rust (random secret key; assetOwner derived from it,
//!      exactly the way the contract derives it: SHA-256("assetOwner:pk:" ++ sk))
//!   3. validates the witness with the real ZKIR `preprocess` (via `ProofPreimage::check`)
//!   4. runs the real PLONK prover (midnight-proofs 0.7.1, KZG/BLS12-381, Blake2b FS)
//!   5. verifies the proof with the verifier key (regenerated from the same IR)
//!   6. negative tests: a tampered proof and a tampered statement must both be rejected.
//!
//! The SRS (KZG public parameters) is fetched once from srs.midnight.network into
//! ./params (override the cache with MIDNIGHT_PP, the URL with MIDNIGHT_PARAM_SOURCE).

use anyhow::{anyhow, bail, Result};
use base_crypto::data_provider::{FetchMode, MidnightDataProvider, OutputMode};
use base_crypto::hash::persistent_hash;
use base_crypto::repr::BinaryHashRepr;
use midnight_zkir::{Instruction as I, IrSource};
use rand::rngs::OsRng;
use rand::RngCore;
use serialize::{Deserializable, Serializable};
use std::time::Instant;
use transient_crypto::curve::Fr;
use transient_crypto::fab::{AlignmentExt, ValueReprAlignedValue};
use transient_crypto::hash::transient_commit;
use transient_crypto::proofs::{
    KeyLocation, ProofPreimage, ProverKey, VerifierKey, Zkir, PARAMS_VERIFIER,
};
use transient_crypto::repr::FieldRepr;

/// Compact hex rendering of a field element (little-endian bytes, trailing zeros trimmed).
fn h(f: &Fr) -> String {
    let mut b = f.as_le_bytes();
    while b.len() > 1 && b.last() == Some(&0) {
        b.pop();
    }
    format!("0x{}", hex::encode(b))
}

/// Random field element with ~248 bits of entropy.
fn random_fr() -> Fr {
    let mut b = [0u8; 31];
    OsRng.fill_bytes(&mut b);
    Fr::from_le_bytes(&b).expect("31 bytes always fit in Fr")
}

/// Build a valid `ProofPreimage` for proveOwnership by interpreting the ZKIR the same
/// way `zkir/src/ir_vm.rs::preprocess` does, but *generating* the three transcript
/// streams instead of validating them:
///   - private_transcript        <- the values we choose (is_some=1, sk as 8-bit + 248-bit limbs)
///   - public_transcript_inputs  <- one entry per `declare_pub_input` (the values the program declares)
///   - public_transcript_outputs <- one entry per `public_input` (the "ledger reads"):
///       read #0 = assetExpired = 0 (false), reads #1,#2 = assetOwner = output limbs of
///       the in-program persistent_hash — i.e. the stored owner really is hash(prefix ++ sk).
fn generate_preimage(ir: &IrSource, private_vals: &[Fr]) -> Result<ProofPreimage> {
    let mut memory: Vec<Fr> = Vec::new(); // num_inputs = 0 for proveOwnership
    let mut pti: Vec<Fr> = Vec::new(); // public_transcript_inputs
    let mut pto: Vec<Fr> = Vec::new(); // public_transcript_outputs
    let mut outputs: Vec<Fr> = Vec::new();
    let mut private_iter = private_vals.iter().copied();
    let mut hash_out: Vec<Fr> = Vec::new();
    let mut hash_consumed = 0usize;
    let mut reads = 0usize;

    fn idx(m: &[Fr], i: u32) -> Result<Fr> {
        m.get(i as usize)
            .copied()
            .ok_or_else(|| anyhow!("memory index {i} out of bounds"))
    }
    fn idx_bool(m: &[Fr], i: u32) -> Result<bool> {
        let v = idx(m, i)?;
        if v == 0.into() {
            Ok(false)
        } else if v == 1.into() {
            Ok(true)
        } else {
            bail!("expected boolean at {i}")
        }
    }

    for ins in ir.instructions.iter() {
        match ins {
            I::LoadImm { imm } => memory.push(*imm),
            I::PrivateInput { guard } => match guard {
                Some(g) if !idx_bool(&memory, *g)? => memory.push(0.into()),
                _ => memory.push(
                    private_iter
                        .next()
                        .ok_or_else(|| anyhow!("ran out of private values"))?,
                ),
            },
            I::PublicInput { guard } => {
                let val = match guard {
                    Some(g) if !idx_bool(&memory, *g)? => 0.into(),
                    _ => {
                        // Oracle for the "ledger reads" of proveOwnership:
                        // first read is assetExpired (false); the following reads are the
                        // assetOwner limbs, which by construction equal the hash outputs.
                        let v = if reads == 0 {
                            Fr::from(0)
                        } else {
                            let v = *hash_out.get(hash_consumed).ok_or_else(|| {
                                anyhow!("public read #{reads} before/without a hash output")
                            })?;
                            hash_consumed += 1;
                            v
                        };
                        reads += 1;
                        pto.push(v);
                        v
                    }
                };
                memory.push(val);
            }
            I::DeclarePubInput { var } => pti.push(idx(&memory, *var)?),
            I::PiSkip { .. } => {} // guards are active in this circuit; preprocess will verify
            I::ConstrainToBoolean { var } => {
                idx_bool(&memory, *var)?;
            }
            I::ConstrainBits { .. } => {} // range checks re-validated by the real preprocess
            I::Assert { cond } => {
                if !idx_bool(&memory, *cond)? {
                    bail!("assertion failed during generation");
                }
            }
            I::TestEq { a, b } => {
                let eq = idx(&memory, *a)? == idx(&memory, *b)?;
                memory.push(if eq { 1.into() } else { 0.into() });
            }
            I::CondSelect { bit, a, b } => {
                let v = if idx_bool(&memory, *bit)? {
                    idx(&memory, *a)?
                } else {
                    idx(&memory, *b)?
                };
                memory.push(v);
            }
            I::PersistentHash { alignment, inputs } => {
                // Identical to the arm in ir_vm.rs preprocess (midnight-ledger @ 272c25fc)
                let vals = inputs
                    .iter()
                    .map(|i| idx(&memory, *i))
                    .collect::<Result<Vec<_>>>()?;
                let value = alignment
                    .parse_field_repr(&vals)
                    .ok_or_else(|| anyhow!("inputs did not match alignment"))?;
                let mut repr = Vec::new();
                ValueReprAlignedValue(value).binary_repr(&mut repr);
                let hash = persistent_hash(&repr);
                let fields = hash.field_vec();
                hash_out = fields.clone();
                hash_consumed = 0;
                memory.extend(fields);
            }
            I::Output { var } => outputs.push(idx(&memory, *var)?),
            other => bail!("op not supported by this generator: {other:?}"),
        }
    }

    // Communications commitment: Poseidon-style commit over (inputs ++ outputs)
    let comm_rand = random_fr();
    let mut comm_inputs: Vec<Fr> = Vec::new(); // ir.num_inputs == 0
    comm_inputs.extend(outputs.iter());
    let comm = transient_commit(&comm_inputs[..], comm_rand);

    Ok(ProofPreimage {
        inputs: vec![],
        private_transcript: private_vals.to_vec(),
        public_transcript_inputs: pti,
        public_transcript_outputs: pto,
        binding_input: random_fr(),
        communications_commitment: Some((comm, comm_rand)),
        key_location: KeyLocation("proveOwnership".into()),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let artifacts = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../managed/counter".to_string());
    let artifacts = std::path::PathBuf::from(artifacts);

    // Keep the SRS cache inside this folder unless the user overrides it.
    if std::env::var_os("MIDNIGHT_PP").is_none() {
        std::env::set_var("MIDNIGHT_PP", "params");
    }

    println!("== zk-standalone: proveOwnership PLONK prove + verify (no docker, no HTTP) ==");

    // 1. Load the compiled circuit
    let ir = IrSource::load(std::fs::File::open(artifacts.join("zkir/proveOwnership.zkir"))?)?;
    println!(
        "circuit loaded: {} ZKIR instructions, communications commitment: {}",
        ir.instructions.len(),
        ir.do_communications_commitment
    );

    // 2. Generate a witness: random secret key, split as the Compact encoding does
    //    (Bytes<32> -> one 8-bit limb + one 248-bit limb), plus is_some = 1.
    let mut lo = [0u8; 1];
    OsRng.fill_bytes(&mut lo);
    let mut hi = [0u8; 31];
    OsRng.fill_bytes(&mut hi);
    let private = vec![
        Fr::from(1), // Maybe.is_some
        Fr::from(lo[0] as u64),
        Fr::from_le_bytes(&hi).expect("31 bytes fit"),
    ];
    let preimage = generate_preimage(&ir, &private)?;
    println!(
        "witness generated: {} private, {} declared public inputs, {} ledger reads",
        preimage.private_transcript.len(),
        preimage.public_transcript_inputs.len(),
        preimage.public_transcript_outputs.len()
    );

    println!("\n-- THE SECRET (witness / private_transcript; never leaves this process) --");
    println!("  sk (32 bytes)        = {}{}", hex::encode(lo), hex::encode(hi));
    println!("  [0] Maybe.is_some    = {}", h(&preimage.private_transcript[0]));
    println!("  [1] sk limb (8-bit)  = {}", h(&preimage.private_transcript[1]));
    println!("  [2] sk limb (248-bit)= {}", h(&preimage.private_transcript[2]));

    println!("\n-- LEDGER READS (public_transcript_outputs; the contract state) --");
    println!("  [0] assetExpired     = {}", h(&preimage.public_transcript_outputs[0]));
    println!("  [1] assetOwner lo    = {}   <- SHA-256(\"assetOwner:pk:\"++sk) limb", h(&preimage.public_transcript_outputs[1]));
    println!("  [2] assetOwner hi    = {}   <- SHA-256(\"assetOwner:pk:\"++sk) limb", h(&preimage.public_transcript_outputs[2]));

    println!("\n-- DECLARED PUBLIC INPUTS (public_transcript_inputs; the transcript ops) --");
    for (i, v) in preimage.public_transcript_inputs.iter().enumerate() {
        println!("  [{i:2}] {}", h(v));
    }

    println!("\n-- BINDING & COMMITMENT --");
    println!("  binding_input        = {}", h(&preimage.binding_input));
    let (cc, cr) = preimage.communications_commitment.unwrap();
    println!("  comm commitment      = {}", h(&cc));
    println!("  comm randomness      = {}", h(&cr));
    println!();

    // 3. Validate with the REAL preprocess (same code path the proof server runs)
    let t = Instant::now();
    preimage.check(&ir).map_err(|e| anyhow!("{e}"))?;
    println!("witness check (real ZKIR preprocess): OK in {:?}", t.elapsed());

    // 4. Keys. The .prover/.verifier files in managed/counter use the legacy container
    //    format of proof-server 4.0.0 and cannot be parsed by the current published
    //    crates — so we regenerate the key pair for the SAME circuit (the IR loaded
    //    above, byte-identical to what the container proves) with the pinned engine,
    //    and cache the result in ./keys for subsequent runs.
    let provider = MidnightDataProvider::new(FetchMode::OnDemand, OutputMode::Log, vec![])
        .map_err(|e| anyhow!("{e}"))?;
    std::fs::create_dir_all("keys")?;
    let (pk, vk): (ProverKey<IrSource>, VerifierKey) = if let (Ok(pkb), Ok(vkb)) = (
        std::fs::read("keys/proveOwnership.pk"),
        std::fs::read("keys/proveOwnership.vk"),
    ) {
        let pk = Deserializable::deserialize(&mut &pkb[..], 0)?;
        let vk = Deserializable::deserialize(&mut &vkb[..], 0)?;
        println!("keys loaded from ./keys cache");
        (pk, vk)
    } else {
        let t = Instant::now();
        let (pk, vk) = ir.keygen(&provider).await.map_err(|e| anyhow!("{e}"))?;
        println!("key pair regenerated at engine v0.7.1 in {:?}", t.elapsed());
        let mut buf = Vec::new();
        Serializable::serialize(&pk, &mut buf)?;
        std::fs::write("keys/proveOwnership.pk", &buf)?;
        let mut buf = Vec::new();
        Serializable::serialize(&vk, &mut buf)?;
        std::fs::write("keys/proveOwnership.vk", &buf)?;
        (pk, vk)
    };
    let k = pk.init().map_err(|e| anyhow!("{e}"))?.k();
    println!("prover key ready (k = {k}, rows = 2^{k})");

    // 5. PROVE — the exact call chain of the proof server: Zkir::prove ->
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
    println!("\n-- THE STATEMENT THE VERIFIER CHECKS (final public-input vector) --");
    println!("  [ 0] binding_input   = {}", h(&pis[0]));
    println!("  [ 1] comm commitment = {}", h(&pis[1]));
    for (i, v) in pis.iter().enumerate().skip(2) {
        println!("  [{i:2}] transcript      = {}", h(v));
    }
    println!("\n-- THE PROOF (first 64 of {} bytes) --", proof.0.len());
    println!("  {}...", hex::encode(&proof.0[..64]));
    println!();

    // 6. VERIFY — against the verifier key and the embedded verifier parameters
    //    (transient-crypto's PARAMS_VERIFIER).
    let t = Instant::now();
    vk.verify(&PARAMS_VERIFIER, &proof, pis.iter().copied())
        .map_err(|e| anyhow!("{e}"))?;
    println!("VERIFY: {:?}  -> proof ACCEPTED", t.elapsed());

    // 7. Negative tests: tampering must be caught.
    let mut bad_proof = proof.clone();
    let mid = bad_proof.0.len() / 2;
    bad_proof.0[mid] ^= 0x01;
    match vk.verify(&PARAMS_VERIFIER, &bad_proof, pis.iter().copied()) {
        Err(_) => println!("tampered proof:      correctly REJECTED"),
        Ok(()) => bail!("SOUNDNESS BUG: tampered proof was accepted!"),
    }
    let mut bad_pis = pis.clone();
    bad_pis[2] = bad_pis[2] + Fr::from(1);
    match vk.verify(&PARAMS_VERIFIER, &proof, bad_pis.iter().copied()) {
        Err(_) => println!("tampered statement:  correctly REJECTED"),
        Ok(()) => bail!("SOUNDNESS BUG: tampered statement was accepted!"),
    }

    println!("== end-to-end prove + verify complete, all checks passed ==");
    Ok(())
}
