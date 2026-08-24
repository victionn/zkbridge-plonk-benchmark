# proveOwnership, Explained Simply — PLONK for the First Time

This is the beginner's version of [PROVEOWNERSHIP-CALL-TRACE.md](PROVEOWNERSHIP-CALL-TRACE.md).
No cryptography background assumed. Same journey, plain language, one running example.
Whenever you want the real code, follow the **(hop N)** markers into the trace doc.

---

## 1. What are we even trying to do?

Your contract stores a public value called `assetOwner`. It was made like this:

```
assetOwner = SHA-256("assetOwner:pk:" + your secret key)
```

`proveOwnership` has to convince the blockchain of one sentence:

> **"I know a secret key that hashes to `assetOwner` — but I won't show it to you."**

That's the whole game. The "won't show it to you" part is what makes it *zero-knowledge*,
and PLONK is the machine that makes such a proof possible, small (~a few KB), and fast to
check (~milliseconds), no matter how big the computation was.

**A simpler stand-in we'll use for the math:** instead of SHA-256, imagine proving

> "I know a secret number x such that **x³ + x + 5 = 35**"  (the secret is x = 3)

Same shape — secret in, public answer out — just small enough to follow with actual numbers.

---

## 2. The three machines involved

```
┌──────────────────┐  builds the claim   ┌──────────────────┐   tiny proof   ┌──────────────┐
│ your Node process │ ──────────────────▶ │ proof server     │ ─────────────▶ │ Midnight node │
│ (JavaScript)      │                     │ (Rust, Docker,   │                │ (blockchain)  │
│                   │ ◀────────────────── │ localhost:6300)  │                │ checks it     │
└──────────────────┘   proof comes back  └──────────────────┘                └──────────────┘
```

- **Your JS process** runs the contract logic normally and writes down everything that happened.
- **The proof server** (on *your own laptop* — the secret never leaves it) turns that record into a proof.
- **The blockchain** never sees your secret. It only checks the proof — one cheap equation.

`circuitProofMs` in this benchmark = how long the middle box takes.

---

## 3. Step one: run the program and take notes (hops 1–9)

Before anything cryptographic happens, your circuit just… runs. As ordinary JavaScript.

`proveOwnership` executes: fetch the secret key from your local database, check the asset
isn't expired, hash the key, compare with `assetOwner`. While it runs, the SDK writes
three lists:

| List | Contains | For our toy example |
|---|---|---|
| **private inputs** | your secret key | the number **3** |
| **public transcript** | every read of blockchain state | "read `assetExpired` → false, read `assetOwner` → 0x4a…" | 
| **output** | the result | `true` |

Think of it as doing your homework in pencil first, keeping every intermediate step,
because next you'll have to *prove* the homework was done right — without showing the pencil work.

---

## 4. Step two: turn the computation into a spreadsheet (hops 10–12, 21, 27)

Here's the key mental shift for PLONK: **a computation is a table.**

Every small step gets one row. Our toy `x³ + x + 5 = 35` becomes:

| row | step | a | b | c | rule for this row |
|---|---|---|---|---|---|
| 0 | x · x = x² | 3 | 3 | 9 | a × b = c |
| 1 | x² · x = x³ | 9 | 3 | 27 | a × b = c |
| 2 | x³ + x = 30 | 27 | 3 | 30 | a + b = c |
| 3 | 30 + 5 = 35 | 30 | – | 35 | a + 5 = c |

Two kinds of rules make the table trustworthy:

1. **Row rules ("gates")** — each row's arithmetic must hold: `3 × 3 = 9` ✓.
2. **Copy rules ("wires")** — values that should be the same *must* be the same:
   the `9` produced in row 0 is the same `9` used in row 1; all the `3`s are the same x.
   Without these, you could write a perfect-looking table full of unrelated numbers.

And one **anchor to reality**: the final `35` is pinned to the *public* value everyone
knows. For the real circuit, that anchor is `assetOwner` and `assetExpired`.

The real proveOwnership table is the same idea, just bigger: the compiled circuit
(`managed/counter/zkir/proveOwnership.zkir` — 52 instructions) expands into a few
thousand rows, almost all of them doing one thing: **SHA-256, step by step**, because
hashing is a big pile of tiny bit operations. That's why the proof takes ~seconds:
you're proving every micro-step of a hash function.

---

## 5. Step three: the magic — prove the table is right without showing it (hops 29–39)

Now the proof server has the filled-in table. It cannot just send the table — that would
reveal your secret (it's sitting right there in column a). Instead, PLONK does five tricks.

### Trick 1 — Seal the columns in envelopes (commitments)

Each column of numbers gets crushed into one short "fingerprint" (a *commitment* —
mathematically: the column becomes a polynomial, and the fingerprint is one point on an
elliptic curve). Key properties:

- the fingerprint **doesn't reveal** the column (extra random numbers are stirred in), and
- once sent, you **cannot change** the column without the fingerprint breaking.

The prover sends fingerprints for columns a, b, c. The table is now locked in.

### Trick 2 — Random challenges the prover can't predict

Everything from here follows a rhythm: *prover commits → a random number appears →
prover must answer for that random number*. The randomness comes from hashing everything
sent so far (so nobody has to be online — this is the "Fiat–Shamir" trick). Because each
challenge arrives **after** the table is sealed, the prover can't tailor the table to it.
It's an exam where you hand in your notes first, and *then* the questions are chosen.

### Trick 3 — Prove all the copy rules with one telescoping product

How do you prove "these four cells all contain the same value" without opening them?

For each cell, build a fraction using two fresh random numbers β, γ. Set it up so that
if the cells really match, the fractions are the *same list of factors*, top and bottom,
just shuffled — so multiplying them all gives exactly **1**:

```
honest  (both cells are 7):   (7+1β+γ)(7+2β+γ)      shuffled copies
                              ────────────────  = 1
                              (7+2β+γ)(7+1β+γ)

cheating (7 and an 8):        (7+1β+γ)(8+2β+γ)
                              ────────────────  ≠ 1   (for random β,γ — chance ≈ 2⁻²⁵⁵)
                              (7+2β+γ)(8+1β+γ)
```

The prover commits to the running product; a row rule forces it to end at 1.
One product certifies *every* copy rule in the table at once. (The same trick with a
lookup table proves every SHA-256 chunk is a *valid* chunk — that's the "lookup argument".)

### Trick 4 — Compress "every row is correct" into one division

Bundle all the rules into one giant expression C that must equal **0 on every row**.
Math fact: a polynomial that's zero on all n rows is cleanly divisible by one fixed
polynomial, `Xⁿ − 1`. So the prover computes

```
h = C ÷ (Xⁿ − 1)
```

and seals h in an envelope too. Here's the trap for cheaters: if even **one** row is
wrong (say you claimed x = 4, so row 3 reads 68 + 5 = 35 — off by 38), the division
**doesn't come out even**. There's a remainder, so no valid h exists, so there's nothing
honest to commit to. The cheat is now baked into the envelopes.

### Trick 5 — Spot-check at one random point

Final challenge: a random number x\* out of ~2²⁵⁵ possibilities. The prover must open
tiny peepholes in the envelopes: the value of each sealed column at exactly the point
x\* — a handful of numbers, still revealing nothing about your secret. The verifier plugs
them into one equation:

```
C(x*)  =  h(x*) · (x*ⁿ − 1)      ?
```

If the table was honest, this holds everywhere, so it holds at x\*. If anything was
wrong, the two sides differ *almost everywhere*, and a random x\* catches it with
overwhelming probability. **Checking one random point ≈ checking every row.**
A last mini-proof (the "KZG opening", one more envelope) certifies the peephole values
themselves weren't lied about.

---

## 6. Step four: the proof travels (hops 41–46)

What comes out is a small bundle: a dozen-ish envelope fingerprints + the peephole
numbers + one closing envelope. A few kilobytes, whether the circuit had 4 rows or 4 million.

- The proof server **checks its own proof first** (hop 41 — a nice touch in Midnight's code),
- attaches it to your transaction, sends it back to your JS process,
- your wallet adds a *second* proof of the same kind for the transaction fee coins,
- and the Midnight node verifies everything with essentially **one equation**
  (a "pairing check") against the small verifier key your contract stored on-chain at deploy.

The node never saw your secret key. It never even saw the table. It saw envelopes,
peepholes, and math that only works out if the table was real.

---

## 7. The whole thing on one line each

```
1. Run the program normally, keep notes.                        (JS, your machine)
2. Rewrite the notes as a table: rows = steps, columns = values.
3. Seal each column into a fingerprint.                          ← nothing revealed
4. Random challenges force honesty about copies & lookups.       ← telescoping products
5. All row rules ÷ (Xⁿ−1) — only divides cleanly if all correct. ← the PLONK division
6. Spot-check everything at one random point.                    ← one check ≈ all rows
7. Ship a few KB; the chain verifies with one equation.
```

## 8. Map back to the real thing

| In this explainer | In proveOwnership |
|---|---|
| secret x = 3 | your 32-byte `assetOwnerSecretKey` |
| x³ + x + 5 | SHA-256("assetOwner:pk:" ‖ sk), unrolled into thousands of rows |
| public 35 | `assetOwner`, `assetExpired`, and the transaction binding |
| 4-row table | ~2^k rows, dozens of columns |
| "envelopes" | KZG commitments on the BLS12-381 curve (one MSM each — that's your `circuitProofMs`) |
| random challenges | Blake2b hash of the transcript (θ, β, γ, y, x…) |
| the spreadsheet-maker | the ZKIR interpreter in the proof server |
| the envelope math | `midnight-proofs` (Midnight's fork of Halo2) |

## Where to go deeper

- Every hop with exact code lines: [PROVEOWNERSHIP-CALL-TRACE.md](PROVEOWNERSHIP-CALL-TRACE.md)
- The PLONK rounds with real Rust snippets + this same toy example: [PLONK-PROVER-WALKTHROUGH.md](PLONK-PROVER-WALKTHROUGH.md)
- The proof server's internals and how to reproduce everything: [PROOF-SERVER-INTERNALS.md](PROOF-SERVER-INTERNALS.md)
