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

---

## Appendix — A worked toy example

Everything above, but with numbers you can check by hand. Toy statement:

> **"I know a secret x such that x³ + x + 5 = 35"** (secret: x = 3)

This plays the role of proveOwnership's *"I know sk such that SHA-256(prefix ‖ sk) =
assetOwner"* — same shape (secret in, public value out), just small enough to trace.

### Step A — Arithmetize (what ZKIR pass 2 does for us)

PLONK circuits are a table. Three witness columns `a, b, c` (our "advice columns") and
one gate equation controlled by fixed selector columns:

```
q_M·(a·b) + q_L·a + q_R·b + q_O·c + q_C = 0        (one equation, every row)
```

Our computation becomes 4 rows:

| row | meaning        | a  | b | c  | selectors                  | check              |
|-----|----------------|----|---|----|----------------------------|--------------------|
| 0   | x·x = x²       | 3  | 3 | 9  | q_M=1, q_O=−1              | 3·3 − 9 = 0        |
| 1   | x²·x = x³      | 9  | 3 | 27 | q_M=1, q_O=−1              | 9·3 − 27 = 0       |
| 2   | x³ + x = 30    | 27 | 3 | 30 | q_L=1, q_R=1, q_O=−1       | 27 + 3 − 30 = 0    |
| 3   | 30 + 5 = out   | 30 | 0 | 35 | q_L=1, q_C=5, q_O=−1       | 30 + 5 − 35 = 0    |

`c` at row 3 is bound to the **public input** 35 (like `assetOwner` in our circuit).

Notice the gate equation alone does NOT make this sound: nothing yet forces the `9` in
row 1 column `a` to be the same `9` produced in row 0 column `c`. Those are the **copy
constraints** (wires):

```
a0 = b0 = b1 = b2   (all are x)      c0 = a1   (x²)
c1 = a2   (x³)                       c2 = a3   (30)
```

That's exactly what ZKIR's memory indices become: every time an instruction reuses
`var 9`, that's a copy constraint between two cells.

### Step B — Columns become polynomials (Round 1)

Pick a domain of 4 points {1, ω, ω², ω³} (ω = 4th root of unity). Interpolate column `a`
so that a(1)=3, a(ω)=9, a(ω²)=27, a(ω³)=30 — same for b, c. Append random values in the
tail rows (blinding), then commit:

```
[a] = commit(a(X)),  [b] = commit(b(X)),  [c] = commit(c(X))
```

Each `[·]` is a single BLS12-381 point (an MSM over the SRS). After these three points
hit the transcript, the prover can never change the table.

### Step C — Copy constraints via the grand product (Round 3)

How do you prove `a0 = b0 = b1 = b2` *without revealing the values*? The permutation
argument. Label every cell with a distinct index, and let σ be the permutation that
cycles each wire's cells. The prover receives random β, γ and forms, per cell:

```
        value + β·(cell index) + γ
ratio = ---------------------------
        value + β·σ(cell index) + γ
```

**Mini demo that the telescoping works.** Two cells at indices 1, 2, permutation σ swaps
them (they're supposed to be equal). Honest case, both cells = 7:

```
(7 + 1β + γ)(7 + 2β + γ)
------------------------  = 1        ← numerator and denominator are the same
(7 + 2β + γ)(7 + 1β + γ)              set of factors, just reordered
```

Cheating case, cells are 7 and 8:

```
(7 + 1β + γ)(8 + 2β + γ)
------------------------  ≠ 1  for random β, γ (equality would need β,γ to hit
(7 + 2β + γ)(8 + 1β + γ)        a root of a fixed nonzero polynomial — probability ~ 1/|F|)
```

The prover commits the running product z(X): z(1)=1, and each row multiplies in that
row's ratios. The verifier will later check z(ω·X) = z(X)·(ratios) as a *gate*, plus
z(1) = 1. Product telescopes to 1 ⟺ every copy constraint holds. Identical math for the
lookup product, with (input+β)(table+γ) fractions instead — that's how each SHA-256 limb
is proven to live in the spread table.

### Step D — All gates at once: the quotient (Round 4)

Collect every constraint into one polynomial with powers of a challenge y:

```
C(X) = gate(X) + y·(z-transition rule)(X) + y²·(z(1)=1 rule)(X) + ...
```

By construction C vanishes at all 4 domain points — check row 0: 3·3−9 = 0 ✓, etc.
A polynomial vanishing on {1, ω, ω², ω³} is divisible by

```
Z_H(X) = (X−1)(X−ω)(X−ω²)(X−ω³) = X⁴ − 1
```

so the prover computes and commits **h(X) = C(X) / (X⁴ − 1)**.

Why this catches cheating: suppose the prover used x = 4 but still claimed output 35.
Then row 3 gives 69 + 5 − 35 = 39 ≠ 0 (4³=64, 64+4=68... whichever way you patch the
table, *some* row fails). C no longer vanishes at that row ⇒ C is **not** divisible by
X⁴−1 ⇒ there is no polynomial h to commit to. Anything the prover commits as "h" will
fail the next step.

### Step E — Spot check at a random point (Round 5)

Verifier sends random challenge x* (in reality: Blake2b of the transcript). Prover
reveals the handful of scalars a(x*), b(x*), c(x*), z(x*), z(ω·x*), h(x*)… The verifier
plugs them into one number:

```
C(x*) − h(x*)·(x*⁴ − 1)  ≟  0
```

If the prover cheated, C − h·Z_H is a *nonzero* polynomial of degree ≤ d·n, so it has at
most d·n roots — and the chance a random x* from a ~2²⁵⁵-element field lands on one is
astronomically small (Schwartz–Zippel). One point check ≈ checking all rows.

### Step F — Prove the revealed scalars aren't lies (Round 6, KZG)

Step E only works if a(x*) etc. really are evaluations of the *committed* polynomials.
That's KZG's job. The one-liner: claiming p(x*) = v is the same as claiming that
p(X) − v is divisible by (X − x*), so the prover commits the quotient

```
π = commit( (p(X) − v) / (X − x*) )
```

and the verifier checks one pairing equation `e([p] − v·G, H) = e(π, (s − x*)·H)` using
the SRS (that "s" is the secret from the trusted setup — nobody knows it, it only exists
inside the SRS points from srs.midnight.network). Rounds 6's x₁…x₄ machinery just
batches ~dozens of such openings into a single π.

### Step G — Zero-knowledge

The verifier saw: curve-point commitments (hiding, thanks to the random tail rows from
Round 1), a few evaluations at one random point (blinded the same way), and π. From
x = 3 vs x = 5 the transcripts are statistically indistinguishable. Our real circuit
reveals `assetOwner` and `assetExpired` (declared public inputs) and nothing about `sk`.

### Mapping back to proveOwnership

| Toy | Real (proveOwnership) |
|---|---|
| x = 3 | your 32-byte `assetOwnerSecretKey` (as 2 field limbs) |
| x³ + x + 5 | SHA-256("assetOwner:pk:" ‖ sk), built from ~thousands of spread-table rows |
| 35 (public input) | `assetOwner` + `assetExpired` + binding input + comm. commitment (the 19 `declare_pub_input`s) |
| 4 rows, 3 columns | 2^k rows, dozens of columns (ZkStdLib architecture) |
| copy constraints between 4 rows | every reused ZKIR memory index |
| no lookups | 2 parallel spread-table lookups per SHA-256 row |
| commit = 4-term MSM | commit = 2^k-term MSM in blst ← **your circuitProofMs** |
