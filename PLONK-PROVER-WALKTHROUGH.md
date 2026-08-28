# The PLONK Prover, Round by Round — Annotated Source Walkthrough

This is the "PLONK part" only: the proving protocol exactly as implemented in the crate
our proof server is built from, with the real code for every round **and a running toy
example at the bottom of each round** so you can follow along with numbers. All plumbing
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

## The running example (read this first)

Toy statement, used in every round below:

> **"I know a secret x such that x³ + x + 5 = 35"** (secret: x = 3)

It has the same shape as proveOwnership's *"I know sk such that
SHA-256(prefix ‖ sk) = assetOwner"* — secret in, public value out — just small enough to
trace by hand.

[bridge.compact:57-68](bridge.compact#L57-L68)

**Arithmetization (what ZKIR pass 2 does for us).** A PLONK circuit is a table. Columns
are *registers*, rows are *steps*. We use three witness columns `a, b, c` ("advice
columns") and one gate equation whose behaviour on each row is chosen by fixed *selector*
columns:

```
q_M·(a·b) + q_L·a + q_R·b + q_O·c + q_C = 0        (one equation, checked on every row)
```

The computation becomes 4 rows:

| row | meaning        | a  | b | c  | selectors                  | gate check         |
|-----|----------------|----|---|----|----------------------------|--------------------|
| 0   | x·x = x²       | 3  | 3 | 9  | q_M=1, q_O=−1              | 3·3 − 9 = 0        |
| 1   | x²·x = x³      | 9  | 3 | 27 | q_M=1, q_O=−1              | 9·3 − 27 = 0       |
| 2   | x³ + x = 30    | 27 | 3 | 30 | q_L=1, q_R=1, q_O=−1       | 27 + 3 − 30 = 0    |
| 3   | 30 + 5 = out   | 30 | 0 | 35 | q_L=1, q_C=5, q_O=−1       | 30 + 5 − 35 = 0    |

`c` at row 3 is bound to the **public input** 35 (the role `assetOwner` plays for us).

The gate equation alone is not enough: nothing yet forces the `9` in row 1 column `a`
to be the same `9` produced in row 0 column `c`. Those links are the **copy constraints**
(the "wires"):

```
a0 = b0 = b1 = b2   (all are x)      c0 = a1   (x²)
c1 = a2   (x³)                       c2 = a3   (30)        c3 = public input 35
```

In our real circuit, every time a ZKIR instruction reuses a memory index (e.g. `var 9`),
that's a copy constraint between two cells of this grid.

Column kinds, because the code refers to them constantly:
- **advice** columns (`a, b, c`) — prover's private values, committed every proof;
- **fixed** columns (`q_M, q_L, …`) — selectors/constants baked into the proving key;
- **instance** columns — public inputs the verifier knows (`35`).

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

### Example

The transcript starts as `Blake2b( vk_of_{x³+x+5 circuit} ‖ 35 )`. Every challenge below
(θ, β, γ, y, x, x₁…x₄) is derived from this running hash. Consequence: a proof made for
"= 35" cannot be replayed as a proof for "= 36" — change the public input and every
challenge changes, so nothing downstream verifies. (For us: the proof is pinned to this
exact `assetOwner`, `assetExpired`, and the transaction's binding input.)

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

### Example

Column `a` is the vector `[3, 9, 27, 30]`. Pick an evaluation domain of 4 points
`{1, ω, ω², ω³}` (ω a 4th root of unity in the field). "Column → polynomial" means: find
the unique degree-<4 polynomial with

```
a(1) = 3,   a(ω) = 9,   a(ω²) = 27,   a(ω³) = 30
```

(that's `lagrange_from_vec` / Lagrange interpolation). Same for `b(X)` from `[3,3,3,0]`
and `c(X)` from `[9,27,30,35]`. In reality a few extra rows are appended and filled with
random values (`*cell = F::random(...)`) — that randomness is what hides the 3s and 9s.

Then one MSM per column:

```
[a] = commit(a(X))     [b] = commit(b(X))     [c] = commit(c(X))
```

each `[·]` a single BLS12-381 point — think "a fingerprint of the polynomial that you can
later do algebra on". These three points go into the transcript. From here on the prover
cannot change any cell of the table without it showing up later.

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

### Example

The toy circuit as written has no lookups, so add one rule: **"x must be a nibble
(0..15)"**. That is a lookup of column `b = [3, 3, 3, 0]` into the fixed table
`S = [0, 1, 2, …, 15]`.

- *Compress* is a no-op here (single-column lookup). With a 2-column lookup like the
  SHA-256 table `(X, ~X)`, compress would form `X + θ·~X` so one number stands for the pair.
- *Sort*: the prover writes permuted copies so equal values line up:

```
A′ = [0, 3, 3, 3]        (b, sorted)
S′ = [0, 3, 1, 2, …]     (table, reordered so S′[i] = A′[i] whenever A′[i] is "new")
```

Halo2's rule, checked later as a gate: on each row either `A′[i] == S′[i]` or
`A′[i] == A′[i−1]`. Row 0: 0==0 ✓. Row 1: 3==3 ✓. Rows 2,3: 3 == previous 3 ✓.

Cheat: if `b` contained 20, there is no way to arrange `A′`/`S′` so that 20 sits next to
a table entry equal to 20 — it isn't in the table. The arrangement itself gets committed
(`[A′]`, `[S′]`), so the prover is stuck with it.

For us: every SHA-256 limb in the circuit is `b` here, and the 3-column spread table
is `S`.

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

### Example

**3a — the x-wire.** We must prove `a0 = b0 = b1 = b2` without revealing that they're
all 3. Give every cell a unique label (the code uses `δʲ·ωⁱ`: column j, row i). Let σ be
the permutation that cycles the cells of each wire: σ(a0)=b0, σ(b0)=b1, σ(b1)=b2,
σ(b2)=a0 (and similarly c0↔a1, c1↔a2, c2↔a3; cells with no wire map to themselves).

For each cell form the ratio from the source comment:

```
        value + β·label      + γ
ratio = ------------------------
        value + β·σ(label)   + γ
```

Over the whole x-wire the numerators are `{3+β·a0+γ, 3+β·b0+γ, 3+β·b1+γ, 3+β·b2+γ}`
and the denominators are the *same four factors* (σ just rotates which label goes
with which cell) — so the product is exactly **1**.

Smallest possible demo, two cells labelled 1 and 2 that σ swaps:

```
honest (both = 7):   (7+1β+γ)(7+2β+γ) / (7+2β+γ)(7+1β+γ)  = 1

cheat (7 and 8):     (7+1β+γ)(8+2β+γ) / (7+2β+γ)(8+1β+γ)  ≠ 1
                     — for this to equal 1, β,γ would have to be a root of a fixed
                       nonzero polynomial: probability ≈ 1/|F| ≈ 2⁻²⁵⁵
```

The prover then builds z row by row: `z[0]=1, z[1]=z[0]·ratio₀, z[2]=z[1]·ratio₁, …`
(that's the `for row in 1..n` loop), commits `[z]`. Later a *gate* checks
`z(ωX) = z(X)·ratio(X)` on every row and `z(1)=1`; because the total product telescopes
to 1, this passes iff every copy constraint holds. Critically, β and γ were sampled
*after* `[a],[b],[c]` were committed — the prover couldn't pick values to fool them.

**3b — the nibble lookup.** Same mechanic with the Round 2 columns:
numerator per row `(b[i]+β)(S[i]+γ)`, denominator `(A′[i]+β)(S′[i]+γ)`. Since A′ is a
permutation of b and S′ a permutation of S (padded), the multiset of factors is the same
top and bottom → product is 1. The `batch_invert` just computes all the denominators'
inverses in one pass.

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

### Example

Write the gate as a polynomial using the column polynomials from Round 1:

```
gate(X) = q_M(X)·a(X)·b(X) + q_L(X)·a(X) + q_R(X)·b(X) + q_O(X)·c(X) + q_C(X)
```

Evaluate it at each domain point = each row: row 0 → 1·3·3 + 0 + 0 + (−1)·9 + 0 = 0;
row 1 → 27−27 = 0; row 2 → 27+3−30 = 0; row 3 → 30+5−35 = 0. So `gate(X)` is zero on
all of `{1, ω, ω², ω³}`.

Fold *everything* with y (this is what `evaluate_h` builds):

```
C(X) = gate(X)
     + y  · [ z(ωX)·denominators(X) − z(X)·numerators(X) ]    ← permutation rule (3a)
     + y² · [ L₀(X)·(z(X) − 1) ]                               ← z starts at 1
     + y³ · [ lookup rules (3b, Round 2 sortedness) ]
     + …
```

Each bracket is zero on every row if the prover is honest, so C is zero on every row,
so C is divisible by the polynomial that vanishes exactly there:

```
Z_H(X) = (X−1)(X−ω)(X−ω²)(X−ω³) = X⁴ − 1
```

The prover computes **h(X) = C(X) / (X⁴ − 1)** — exact division, no remainder — and
commits `[h]` (in pieces, since h has degree ≈ 3·4).

**Cheat.** Suppose the prover only knows x = 4. Honest arithmetic gives the table
`a=[4,16,64,68], c=[16,64,68,73]` — but c₃ must copy the public input 35, so they
overwrite c₃ = 35. Now row 3: 68 + 5 − 35 = 38 ≠ 0. `gate(ω³) = 38`, so C(ω³) ≠ 0, so
**C is not divisible by X⁴−1**: the "division" leaves a remainder and there is no
polynomial h with h·(X⁴−1) = C. Whatever the prover commits as `[h]` is a lie that
Round 5 will expose. (Patching the table any other way just moves the nonzero to a
different row or breaks a copy constraint in Round 3 — same outcome.)

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

### Example

The transcript hash now yields a challenge point x\* — some essentially random field
element, *not* one of the 4 domain points. The prover evaluates its polynomials there and
sends just the numbers:

```
a(x*), b(x*), c(x*),  z(x*), z(ω·x*),  h(x*),  plus the fixed/selector evals
```

(`rotate_omega(x, at)` is how "next row" queries like z(ω·x\*) are produced.)

The verifier can now compute C(x\*) itself from those scalars — it knows the gate
formula, y, β, γ — and checks a single field equation:

```
C(x*)  ≟  h(x*) · (x*⁴ − 1)
```

Why one point is enough: if the prover cheated, `C(X) − h(X)·(X⁴−1)` is some *nonzero*
polynomial of degree ≤ ~12 (toy) or ≤ d·2^k (real). A nonzero polynomial of degree D has
at most D roots. x\* was chosen uniformly from ~2²⁵⁵ field elements *after* everything
was committed, so the chance it lands on one of those ≤ D roots is ≈ D/2²⁵⁵ — i.e. never.
That's Schwartz–Zippel: evaluating at one random point is as good as checking every row.

In the x=4 cheat from Round 4: C(x\*) − h(x\*)(x\*⁴−1) ≠ 0 for any h the prover could
have committed, and the check fails.

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

### Example

Round 5 only works if `a(x*)` really *is* the evaluation of the polynomial behind `[a]`
— otherwise the prover could just send whatever scalars make the equation balance. KZG
closes that hole.

**Single opening, the core idea.** Claim: `a(x*) = v`. Then `a(X) − v` has a root at x\*,
so it is divisible by `(X − x*)`:

```
w(X) = (a(X) − v) / (X − x*)        ← exact division iff the claim is true
π    = commit(w(X))                 ← one more curve point
```

The verifier checks one pairing equation using the SRS:

```
e( [a] − v·G ,  H )  =  e( π ,  (s − x*)·H )
```

Here `s` is the trusted-setup secret: nobody knows it, but `s·H` and the powers `sⁱ·G`
exist inside the SRS files from srs.midnight.network, which is exactly what lets both
sides be computed "in the exponent" without knowing s. If v is wrong, the division isn't
exact, and no π satisfies the equation.

**Batching (what x₁…x₄ do).** The toy needs ~10 openings (a, b, c, z, h… at x\*, plus z at
ω·x\*); the real circuit needs dozens. Opening each separately would mean dozens of π's
and dozens of pairings. Instead:

- x₁: combine all polynomials opened at the *same* point-set into one `q` each
  (`q = a + x₁·b + x₁²·c + …`) — a random linear combination is wrong iff any term is
  wrong;
- Kate-divide each q by its points and combine with x₂ into `f_poly`; commit `[f]`;
- x₃: fresh opening point; send each q(x₃);
- x₄: fold all q's and f into `final_poly`; π = its single KZG witness at x₃.

Net result: **one π, one pairing check**, covering every evaluation in the proof.

---

## The verifier (mirror image)

The verifier replays the same transcript, folds every commitment and evaluation into two
multi-scalar multiplications (`multi_prepare` → `DualMSM`, `src/poly/kzg/mod.rs:192+`,
gate logic in `src/plonk/verifier.rs`), and accepts iff **one pairing equation** on
BLS12-381 holds. Constant work, regardless of circuit size.

### Example

What the verifier holds at the end, for the toy:

```
commitments : [a] [b] [c]  [A′] [S′]  [z_perm] [z_lookup]  [rand]  [h]  [f]  π
scalars     : a(x*) b(x*) c(x*) z(x*) z(ωx*) h(x*) …  q_i(x₃)
public      : 35, the vk
```

It re-derives θ, β, γ, y, x\*, x₁…x₄ by re-hashing the transcript (Blake2b) — so the
prover couldn't have chosen them — recomputes `C(x*)` from the scalars, checks
`C(x*) = h(x*)(x*⁴−1)`, then folds all commitments/evaluations into two MSMs and runs the
single pairing check that certifies every scalar is an honest opening. Cost is a fixed
handful of curve operations whether the circuit has 4 rows or 2^k. A Midnight node does
exactly this against the 2.6 KB verifier key stored in your contract's on-chain state.

### Zero-knowledge, in the example

Across the whole transcript the verifier saw: curve points (hiding, because Round 1 put
random values in the tail rows and Round 4 added a random polynomial), a few evaluations
at one random point (blinded by the same randomness), and π. Run the protocol with x = 3
and with some other secret that also satisfies the relation — the transcripts are
statistically indistinguishable. The only things revealed are the public inputs: `35`
here; `assetOwner` and `assetExpired` (and nothing about `sk`) in proveOwnership.

---

## Mapping the example back to proveOwnership

| Toy | Real (proveOwnership) |
|---|---|
| x = 3 | your 32-byte `assetOwnerSecretKey` (as 2 field limbs) |
| x³ + x + 5 | SHA-256("assetOwner:pk:" ‖ sk), built from ~thousands of spread-table rows |
| 35 (public input) | `assetOwner` + `assetExpired` + binding input + comm. commitment (the 19 `declare_pub_input`s) |
| 4 rows, 3 columns | 2^k rows, dozens of columns (ZkStdLib architecture) |
| copy constraints between 4 rows | every reused ZKIR memory index |
| nibble lookup into {0..15} | 2 parallel spread-table lookups per SHA-256 row |
| commit = 4-term MSM | commit = 2^k-term MSM in blst ← **your circuitProofMs** |

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
