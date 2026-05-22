/**
 * ZK Proof Generation Benchmark
 * ─────────────────────────────
 * Measures PLONK proof generation time for all three circuits in the
 * Cardano-Midnight ZK Bridge contract:
 *
 *   1. constructor    — operator deploys a new zkAsset contract
 *   2. proveOwnership — user proves they own a bridged asset
 *   3. burnAsset      — operator marks a zkAsset as expired
 *
 * What each timing column captures:
 *   circuitProofMs  = HTTP call to proof-server :6300 (pure PLONK work)
 *   walletProofMs   = wallet.proveTransaction() inside Midnight SDK (Zswap proof)
 *                     (0 for proveOwnership and burnAsset — we exit before wallet proof)
 *   totalCallTxMs   = same as circuitProofMs for proof-only calls
 *
 * Prerequisites:
 *   - Proof server running locally:  docker compose -f proof-server.yml up -d
 *   - Midnight wallet with tDUST:    set BENCH_WALLET_SEED env var
 *   - (optional) BENCH_ENV=standalone for local Docker stack
 *   - (optional) BENCH_ITERATIONS=N  (default 3)
 *
 * Usage:
 *   BENCH_WALLET_SEED=<hex_seed> yarn bench
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import crypto from 'node:crypto';
import { persistentHash, CompactTypeVector, CompactTypeBytes } from '@midnight-ntwrk/compact-runtime';
import * as api from './api.js';
import { resolveConfig, currentDir } from './config.js';
import { createLogger } from './logger-utils.js';
import { timings, printSummary } from './timings.js';
import { type DeployedCounterContract } from './common-types.js';
import { type Resource } from '@midnight-ntwrk/wallet';
import { type Wallet } from '@midnight-ntwrk/wallet-api';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? '3');

const WALLET_SEED = (() => {
  const seed = process.env.BENCH_WALLET_SEED;
  if (!seed) {
    throw new Error(
      '\n\nBENCH_WALLET_SEED is not set.\n' +
        'Export your Midnight testnet wallet seed before running:\n' +
        '  export BENCH_WALLET_SEED=<64-char hex seed>\n',
    );
  }
  return seed;
})();

// Operator key (from the bridge repo — used only for deploying test contracts)
const OPERATOR_SK = Buffer.from(
  'b02b7df9b3e2e4f3b1122e85d619f31682ce55c1741a358ee8d277c6c5605b80',
  'hex',
);

// Sample asset IDs taken from the original UT-M1 test
const ASSET_POLICY_ID = 'e42fcc8d7438bbb12f9cf714fd3dc529057098b205110170787f1c2f';
const ASSET_NAME_HEX  = '41537465704265796f6e64303033';
const ASSET_NAME_TEXT = Buffer.from(ASSET_NAME_HEX, 'hex').toString('utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Owner keypair
//
// Generates a realistic secret key and derives its public key the same way
// the Compact contract does — via persistentHash with the "assetOwner:pk:"
// prefix. This ensures proveOwnership is proving a real non-trivial witness,
// not a degenerate all-zeros case.
// ─────────────────────────────────────────────────────────────────────────────

function generateOwnerKeypair(): { secretKey: Buffer; publicKey: Buffer } {
  const secretKey = crypto.randomBytes(32);

  const rt_type = new CompactTypeVector(2, new CompactTypeBytes(32));
  const prefix  = Buffer.alloc(32);
  Buffer.from('assetOwner:pk:').copy(prefix); // zero-padded to 32 bytes

  const publicKey = Buffer.from(persistentHash(rt_type, [prefix, secretKey]));

  return { secretKey, publicKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildAssetID(): Uint8Array {
  const buf = Buffer.alloc(60);
  Buffer.from(ASSET_POLICY_ID, 'hex').copy(buf, 0);
  Buffer.from(ASSET_NAME_HEX,  'hex').copy(buf, 28);
  return buf;
}

function utxoToBytes33(txid: string, index: number): Uint8Array {
  if (txid.length !== 64) throw new Error('txid must be 64 hex chars');
  if (index < 0 || index > 0xff) throw new Error('index must fit in uint8');
  const buf = Buffer.alloc(33);
  Buffer.from(txid, 'hex').copy(buf, 0);
  buf.writeUInt8(index, 32);
  return buf;
}

function fakeTxid(iteration: number, salt: string): string {
  return Buffer.from(`bench-${salt}-${iteration}-`.padEnd(32, '\0')).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test state
// ─────────────────────────────────────────────────────────────────────────────

let wallet: Wallet & Resource;
let providers: Awaited<ReturnType<typeof api.configureProviders>>;
let latestDeployedContract: DeployedCounterContract;

// Generated once in beforeAll, shared across all three suites
let owner: { secretKey: Buffer; publicKey: Buffer };

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('ZK Proof Generation Benchmark', () => {

  beforeAll(async () => {
    const config = resolveConfig();
    const logPath = path.resolve(
      currentDir,
      '..',
      'logs',
      `bench-${new Date().toISOString().replace(/:/g, '-')}.log`,
    );
    const logger = await createLogger(logPath);
    api.setLogger(logger);

    // Generate owner keypair once — reused across all three suites
    owner = generateOwnerKeypair();

    console.log(`\n  Config      : ${config.constructor.name}`);
    console.log(`  Proof       : ${config.proofServer}`);
    console.log(`  Iters       : ${ITERATIONS}`);
    console.log(`  Owner pubkey: ${owner.publicKey.toString('hex')}`);
    console.log(`  Log         : ${logPath}\n`);

    wallet = await api.buildWalletAndWaitForFunds(config, WALLET_SEED);
    providers = await api.configureProviders(wallet, config);
  }, 1000 * 60 * 45);

  afterAll(async () => {
    printSummary();
    wallet.close();
  });

  // ── 1. constructor ─────────────────────────────────────────────────────────
  // Deploys a fresh zkAsset contract for each iteration using the real owner
  // public key. Still awaits full deployment since the contract address is
  // needed for suite 2. Proof time is captured by the proxy before submission.
  describe('1 · constructor (operator deploys zkAsset)', () => {
    it(`runs ${ITERATIONS} iterations`, async () => {
      const assetID = buildAssetID();

      for (let i = 0; i < ITERATIONS; i++) {
        console.log(`  [constructor] iteration ${i + 1}/${ITERATIONS}`);

        latestDeployedContract = await api.deployZkAsset(
          providers,
          { operatorSecretKey: OPERATOR_SK },
          utxoToBytes33(fakeTxid(i, 'ctor'), i % 256),
          assetID,
          ASSET_NAME_TEXT,
          1n,
          owner.publicKey,  // real derived public key
          i,
        );
      }
    });
  });

  // ── 2. proveOwnership ──────────────────────────────────────────────────────
  // Proves ownership using the real secret key that corresponds to the
  // owner public key stored in the contract above. This is the realistic
  // case — the prover has to compute persistentHash over a non-trivial input.
  // Fires callTx without awaiting block confirmation.
  describe('2 · proveOwnership (user proves asset ownership)', () => {
    it(`runs ${ITERATIONS} iterations`, async () => {
      if (!latestDeployedContract) {
        throw new Error('No deployed contract from constructor suite — run suites in order');
      }

      // Join with the matching secret key — must correspond to owner.publicKey
      const ownerContract = await api.joinContract(
        providers,
        latestDeployedContract.deployTxData.public.contractAddress,
        { assetOwnerSecretKey: owner.secretKey },  // real secret key
      );

      for (let i = 0; i < ITERATIONS; i++) {
        console.log(`  [proveOwnership] iteration ${i + 1}/${ITERATIONS}`);
        await api.proveOwnershipProofOnly(ownerContract, i);
      }
    });
  });

  // ── 3. burnAsset ───────────────────────────────────────────────────────────
  // Each iteration needs a fresh contract (burnAsset is terminal).
  // Setup deploys use deployZkAssetSilent so they don't pollute constructor
  // timings. The real owner public key is used to keep deployment realistic.
  // Only the burn proof itself is timed and recorded.
  describe('3 · burnAsset (operator burns zkAsset)', () => {
    it(`runs ${ITERATIONS} iterations`, async () => {
      const assetID = buildAssetID();

      for (let i = 0; i < ITERATIONS; i++) {
        console.log(`  [burnAsset] iteration ${i + 1}/${ITERATIONS} — deploying setup contract…`);

        // Silent deploy — not counted in any timing bucket
        const contract = await api.deployZkAssetSilent(
          providers,
          { operatorSecretKey: OPERATOR_SK },
          utxoToBytes33(fakeTxid(i, 'burn'), i % 256),
          assetID,
          ASSET_NAME_TEXT,
          1n,
          owner.publicKey,  // real derived public key
        );

        const operatorContract = await api.joinContract(
          providers,
          contract.deployTxData.public.contractAddress,
          { operatorSecretKey: OPERATOR_SK },
        );

        console.log(`  [burnAsset] iteration ${i + 1}/${ITERATIONS} — timing burn proof…`);
        await api.burnAssetProofOnly(operatorContract, i);
      }
    });
  });
});