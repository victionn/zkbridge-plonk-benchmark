# The PLONK Prover, Round by Round — Annotated Source Walkthrough

This is the "PLONK part" only: the proving protocol exactly as implemented in the crate
our proof server is built from, with the real code for every round. All plumbing
(SDK, ZKIR, HTTP, worker pool) is covered separately in
[PROOF-SERVER-INTERNALS.md](PROOF-SERVER-INTERNALS.md).

**Source pinned to:** `midnight-proofs` **0.7.1** from crates.io,
sha256 `b48f199fa4707df5dc443238cd260344f2ad369897fbdc559dacce19b43d2119`
(matches `midnight-ledger`'s `Cargo.lock` — see PROOF-SERVER-INTERNALS.md §4.5 for the
download command). All paths are relative to that crate's root; line numbers are exact
for that tarball.

**Setting:** scalar field of BLS12-381; circuit of `n = 2^k` rows; KZG polynomial
commitments (every `commit` is one multi-scalar multiplication in `blst`); Blake2b as
the Fiat–Shamir random oracle. Entry point: `create_proof` at `src/plonk/prover.rs:348`,
which runs trace generation (`prover.rs:99-235`) then `finalise_proof`
(`prover.rs:242-339`).

The proof is the transcript: everything `transcript.write(...)`s below, in order, IS the
proof bytes. Every `squeeze_challenge()` derives the next challenge by hashing the
transcript so far — that is what turns the interactive protocol non-interactive.

---

## Round 0 — Bind the statement

Before anything random happens, the verifying key and the public inputs are hashed into
the transcript, so every later challenge depends on *which* circuit and *which* statement
is being proven.

`src/plonk/prover.rs:98-105`

```rust
    // Hash verification key into transcript
    pk.vk.hash_into(transcript)?;

    let domain = &pk.vk.domain;

    let instance = compute_instances(params, pk, instances, nb_committed_instances, transcript)?;

    let (advice, challenges) = parse_advices(params, pk, circuits, instances, transcript, rng)?;
```

---

## Round 1 — Commit to the witness (advice columns)

`parse_advices` (called above) synthesizes the circuit per phase and lands here: the last
rows of every advice column are overwritten with random field elements (**zero-knowledge
blinding** — these rows are why the ZKIR "usable rows" is slightly less than 2^k), then
each column is committed (one MSM each) and the commitment written to the transcript.
After this the witness is fixed; all soundness rests on challenges being sampled *after*
these commitments.

`src/plonk/prover.rs:556-574`

```rust
            for (column_index, advice_values) in column_indices.iter().zip(&mut advice_values) {
                if !witness.unblinded_advice.contains(column_index) {
                    for cell in &mut advice_values[unusable_rows_start..] {
                        *cell = F::random(&mut *rng);
                    }
                }
                ...
            }

            let advice_commitments: Vec<_> =
                advice_values.iter().map(|poly| CS::commit_lagrange(params, poly)).collect();

            for commitment in &advice_commitments {
                transcript.write(commitment)?;
            }
```

---

## Round 2 — Lookup argument, part 1: compress and sort (challenge θ)

θ keeps the m columns of a multi-column lookup linearly independent.
(In our circuits the lookups come from the SHA-256 spread table —
`midnight-circuits-6.2.0/src/hash/sha256/sha256_chip.rs` — which is what
`persistentHash` compiles to.)

`src/plonk/prover.rs:107-108`

```rust
    // Sample theta challenge for keeping lookup columns linearly independent
    let theta: F = transcript.squeeze_challenge();
```

Each lookup's input expressions A₀..A_{m−1} and table expressions S₀..S_{m−1} are folded
into single columns with powers of θ, then sorted ("permuted") so that every input value
sits next to an equal table value. A′ and S′ are committed.

`src/plonk/lookup/prover.rs:81-115`

```rust
        let compress_expressions = |expressions: &[Expression<F>]| {
            let compressed_expression = expressions
                .iter()
                .map(|expression| { ... evaluate(expression, ...) ... })
                .fold(domain.empty_lagrange(), |acc, expression| {
                    acc * theta + &expression        // A_compressed = Σ θ^j · A_j
                });
            compressed_expression
        };

        // Get values of input expressions involved in the lookup and compress them
        let compressed_input_expression = compress_expressions(&self.input_expressions);

        // Get values of table expressions involved in the lookup and compress them
        let compressed_table_expression = compress_expressions(&self.table_expressions);

        // Permute compressed (InputExpression, TableExpression) pair
        let (permuted_input_expression, permuted_table_expression) = permute_expression_pair(
            pk, domain, rng,
            &compressed_input_expression,
            &compressed_table_expression,
        )?;
```

(The sort itself: `permute_expression_pair`, `src/plonk/lookup/prover.rs:379+`.)

---

## Round 3 — The two grand products (challenges β, γ)

`src/plonk/prover.rs:137-141`

```rust
    // Sample beta challenge
    let beta: F = transcript.squeeze_challenge();

    // Sample gamma challenge
    let gamma: F = transcript.squeeze_challenge();
```

### 3a. Permutation (copy-constraint) grand product — the heart of PLONK

For every column p_j participating in copy constraints ("this cell equals that cell"),
accumulate a running product of fractions. The permutation s_j encodes the wiring; δ^j
separates columns. The telescoping product returns to 1 iff every copy constraint holds.

`src/plonk/permutation/prover.rs:77-83` (the identity, verbatim from the source comment):

```rust
            // Goal is to compute the products of fractions
            //
            // (p_j(\omega^i) + \delta^j \omega^i \beta + \gamma) /
            // (p_j(\omega^i) + \beta s_j(\omega^i) + \gamma)
            //
            // where p_j(X) is the jth column in this permutation,
            // and i is the ith row of the column.
```

Numerator and denominator accumulation (`permutation/prover.rs:94-127`):

```rust
                parallelize(&mut modified_values, |modified_values, start| {
                    for ((modified_values, value), permuted_value) in ...
                    {
                        *modified_values *= &(beta * permuted_value + &gamma + value);  // denominator
                    }
                });
                ...
                        // Multiply by p_j(\omega^i) + \delta^j \omega^i \beta
                        *modified_values *= &(deltaomega * &beta + &gamma + value);     // numerator
                        deltaomega *= &omega;
```

Building z(X) row by row, blinding its tail, committing (`permutation/prover.rs:140-161`):

```rust
            // Compute the evaluations of the permutation product polynomial
            // over our domain, starting with z[0] = 1
            let mut z = vec![last_z];
            for row in 1..(domain.n as usize) {
                let mut tmp = z[row - 1];
                tmp *= &modified_values[row - 1];
                z.push(tmp);
            }
            let mut z = domain.lagrange_from_vec(z);
            // Set blinding factors
            for z in &mut z[domain.n as usize - blinding_factors..] {
                *z = F::random(&mut *rng);
            }
            ...
            let permutation_product_commitment = CS::commit_lagrange(params, &z);
            ...
            transcript.write(&permutation_product_commitment)?;
```

### 3b. Lookup grand product

Same running-product trick, proving every (compressed) input value appears in the
(compressed) table. The identity, verbatim from the source comment
(`src/plonk/lookup/prover.rs:169-181`):

```rust
        // Goal is to compute the products of fractions
        //
        // Numerator: (\theta^{m-1} a_0(\omega^i) + \theta^{m-2} a_1(\omega^i) + ... +
        //              \theta a_{m-2}(\omega^i) + a_{m-1}(\omega^i) + \beta)
        //            * (\theta^{m-1} s_0(\omega^i) + ... + s_{m-1}(\omega^i) + \gamma)
        // Denominator: (a'(\omega^i) + \beta) (s'(\omega^i) + \gamma)
```

Denominators are inverted all at once (`batch_invert`, line 197), then z is built and
blinded exactly like the permutation product (`lookup/prover.rs:228-242`):

```rust
        // Compute the evaluations of the lookup product polynomial
        // over our domain, starting with z[0] = 1
        let z = iter::once(F::ONE)
            .chain(lookup_product)
            .scan(F::ONE, |state, cur| {
                *state *= &cur;
                Some(*state)
            })
            // Take all rows including the "last" row which should
            // be a boolean (and ideally 1, else soundness is broken)
            .take(pk.vk.n() as usize - blinding_factors)
            // Chain random blinding factors.
            .chain((0..blinding_factors).map(|_| F::random(&mut *rng)))
            .collect::<Vec<_>>();
```

> Note: between 3b and round 4 the fork also runs its **trash argument**
> (`prover.rs:175-199`, `src/plonk/trash.rs`) — a Midnight addition, not part of
> standard PLONK, so it is not covered here.

---

## Round 4 — The quotient polynomial h(X) (challenge y)

First a fully random polynomial is committed (it blinds the openings at x₃ later), then
y is sampled to fold all constraints into one.

`src/plonk/prover.rs:201-205` and `src/plonk/vanishing/prover.rs:75-81`

```rust
    // Commit to the vanishing argument's random polynomial for blinding h(x_3)
    let vanishing = vanishing::Argument::<F, CS>::commit(params, domain, rng, transcript)?;

    // Obtain challenge for keeping all separate gates linearly independent
    let y: F = transcript.squeeze_challenge();
```

```rust
        let random_poly: Polynomial<F, Coeff> = domain.coeff_from_vec(rand_vec);

        // Commit
        let c = CS::commit(params, &random_poly);
        transcript.write(&c)?;
```

Every gate polynomial, permutation rule, lookup rule (and trash rule) is evaluated over
an extended coset domain and folded with powers of y — the compute-heaviest non-MSM step
(`compute_h_poly`, `src/plonk/prover.rs:596-651`, driving the `GraphEvaluator` machinery
in `src/plonk/evaluation.rs:172-283`, entry `evaluate_h` at line 284):

```rust
    // Evaluate the h(X) polynomial
    pk.ev.evaluate_h::<ExtendedLagrangeCoeff>(
        &pk.vk.domain,
        &pk.vk.cs,
        &advice_cosets...,
        &instance_cosets...,
        &pk.fixed_cosets,
        challenges,
        *y, *beta, *gamma, *theta,
        ...
```

Then the defining division of PLONK: the folded constraint polynomial is divided by the
vanishing polynomial **t(X) = Xⁿ − 1**. This only yields a polynomial (rather than a
rational function) if every constraint is zero on all n rows — a cheating prover cannot
commit to the result. h(X) has degree ≈ d·n, so it is split into n-sized pieces, each
blinded and committed.

`src/plonk/vanishing/prover.rs:98-129`

```rust
        // Divide by t(X) = X^{params.n} - 1.
        let h_poly = domain.divide_by_vanishing_poly(h_poly);

        // Obtain final h(X) polynomial
        let mut h_poly = domain.extended_to_coeff(h_poly);
        ...
        // Split h(X) up into pieces
        let mut h_pieces = h_poly
            .chunks_exact((domain.n - 1) as usize)
            .map(|v| v.to_vec())
            .collect::<Vec<_>>();
        ...
        blind_quotient_limbs(&mut h_pieces, rng);
        ...
        // Compute commitments to each h(X) piece
        let h_commitments: Vec<_> =
            h_pieces.iter().map(|h_piece| CS::commit(params, h_piece)).collect();

        // Hash each h(X) piece
        for c in h_commitments {
            transcript.write(&c)?;
        }
```

---

## Round 5 — Evaluations at the challenge point x

x is the random evaluation point. The prover writes the scalar value of every committed
polynomial at x (and at rotations ω·x, ω⁻¹·x where gates reference neighboring rows —
e.g. grand products need z(ωx)). By Schwartz–Zippel, checking the constraint identity at
this single random point suffices.

`src/plonk/prover.rs:282-302`

```rust
    let x: F = transcript.squeeze_challenge();

    write_evals_to_transcript(pk, nb_committed_instances, &instance_polys, &advice_polys, x, transcript)?;

    let vanishing = vanishing.evaluate(x, domain, transcript)?;

    // Evaluate common permutation data
    pk.permutation.evaluate(x, transcript)?;

    // Evaluate the permutations, if any, at omega^i x.
    let permutations: Vec<permutation::prover::Evaluated<F>> = permutations
        .into_iter()
        .map(|permutation| -> Result<_, _> { permutation.evaluate(pk, x, transcript) })
        .collect::<Result<Vec<_>, _>>()?;
```

The evaluation kernel (`src/plonk/prover.rs:657-690`):

```rust
    // Compute and hash advice evals for each circuit instance
    for advice in advice_polys.iter() {
        // Evaluate polynomials at omega^i x
        let advice_evals: Vec<_> = meta
            .advice_queries
            .iter()
            .map(|&(column, at)| {
                eval_polynomial(&advice[column.index()], domain.rotate_omega(x, at))
            })
        ...
            transcript.write(&eval)?;
```

---

## Round 6 — One KZG proof for everything (challenges x₁, x₂, x₃, x₄)

The multipoint opening argument proves all the claimed evaluations of Round 5 are
consistent with all the commitments of Rounds 1–4 — with a single final witness
commitment π. x₁ aggregates polynomials sharing the same point-set; Kate division and x₂
build f(X); x₃ is the final opening point; x₄ folds everything into one polynomial whose
KZG opening at x₃ is the last group element of the proof.

`src/poly/kzg/mod.rs:110-188` (abridged to the protocol steps):

```rust
        let x1: E::Fr = transcript.squeeze_challenge();
        let x2: E::Fr = transcript.squeeze_challenge();
        ...
        let q_polys = q_polys.iter().map(|polys| inner_product(polys, powers(x1))).collect();

        let f_poly = {
            let f_polys = point_sets.iter().zip(q_polys.clone())
                .map(|(points, q_poly)| {
                    let mut poly = points.iter().fold(q_poly.clone().values, |poly, point| {
                        kate_division(&poly, *point)          // (q(X) - q(point)) / (X - point)
                    });
                    ...
                })
                .collect::<Vec<_>>();
            inner_product(&f_polys, powers(x2))
        };

        let f_com = Self::commit(params, &f_poly);
        transcript.write(&f_com)?;

        let x3: E::Fr = transcript.squeeze_challenge();

        for q_poly in q_polys.iter() {
            transcript.write(&eval_polynomial(&q_poly.values, x3))?;
        }

        let x4: E::Fr = transcript.squeeze_challenge();

        let final_poly = { let mut polys = q_polys; polys.push(f_poly);
                           inner_product(&polys, powers(x4)) };
        let v = eval_polynomial(&final_poly, x3);

        let pi = {
            let pi_poly = Polynomial {
                values: kate_division(&(&final_poly - v).values, x3),   // the KZG witness
                ...
            };
            Self::commit(params, &pi_poly)
        };

        transcript.write(&pi)
```

---

## The verifier (mirror image)

The verifier replays the same transcript, folds every commitment and evaluation into two
multi-scalar multiplications (`multi_prepare` → `DualMSM`, `src/poly/kzg/mod.rs:192+`,
gate logic in `src/plonk/verifier.rs`), and accepts iff **one pairing equation** on
BLS12-381 holds. Constant work, regardless of circuit size.

---

## Where the time goes

Every `CS::commit` / `CS::commit_lagrange` above is a size-n MSM dispatched to the
`blst` C library (`msm_specific`, `src/poly/kzg/msm.rs:111-125` — blst's
`G1Projective::multi_exp` for sizes ≤ 2^19). Rounds 1, 3, 4 and 6 are MSM-dominated;
Round 4 additionally pays large FFTs (`coeff_to_extended`). For this repo's circuits,
row count — and therefore `circuitProofMs` — is dominated by the SHA-256 spread-table
chip that Compact's `persistentHash` compiles to (see PROOF-SERVER-INTERNALS.md §2.6).

## Reproducing

```bash
curl -s -A 'research' \
  "https://static.crates.io/crates/midnight-proofs/midnight-proofs-0.7.1.crate" \
  -o midnight-proofs-0.7.1.crate
shasum -a 256 midnight-proofs-0.7.1.crate
# b48f199fa4707df5dc443238cd260344f2ad369897fbdc559dacce19b43d2119
tar xzf midnight-proofs-0.7.1.crate
```

Snippets in this document are quoted verbatim from that tarball (some marked `...` where
boilerplate was elided); all line numbers refer to it.
