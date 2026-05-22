/**
 * ZK Proof Generation Benchmark
 * ─────────────────────────────
 * Measures PLONK proof generation time for all three circuits in the
 * Cardano-Midnight ZK Bridge contract:
 *
 *   1. constructor   — operator deploys a new zkAsset contract
 *   2. proveOwnership — user proves they own a bridged asset
 *   3. burnAsset     — operator marks a zkAsset as expired
 *
 * What each timing column captures:
 *   circuitProofMs  = HTTP call to proof-server :6300 (pure PLONK work)
 *   walletProofMs   = wallet.proveTransaction() inside Midnight SDK (Zswap proof)
 *   totalCallTxMs   = full callTx round-trip including block confirmation on testnet
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
const ASSET_NAME_HEX = '41537465704265796f6e64303033'; // hex-encoded UTF-8 name
const ASSET_NAME_TEXT = Buffer.from(ASSET_NAME_HEX, 'hex').toString('utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a 60-byte assetID = 28-byte policyID ++ 32-byte asset name */
function buildAssetID(): Uint8Array {
  const buf = Buffer.alloc(60);
  Buffer.from(ASSET_POLICY_ID, 'hex').copy(buf, 0);
  Buffer.from(ASSET_NAME_HEX, 'hex').copy(buf, 28);
  return buf;
}

/**
 * Encode a UTxO reference as 33 bytes: 32-byte txid ++ 1-byte index.
 * The bridge contract uses this as the policyID (unique per deployed contract).
 */
function utxoToBytes33(txid: string, index: number): Uint8Array {
  if (txid.length !== 64) throw new Error('txid must be 64 hex chars');
  if (index < 0 || index > 0xff) throw new Error('index must fit in uint8');
  const buf = Buffer.alloc(33);
  Buffer.from(txid, 'hex').copy(buf, 0);
  buf.writeUInt8(index, 32);
  return buf;
}

/** Generate a unique fake txid for each benchmark iteration */
function fakeTxid(iteration: number, salt: string): string {
  return Buffer.from(`bench-${salt}-${iteration}-`.padEnd(32, '\0')).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test state
// ─────────────────────────────────────────────────────────────────────────────

let wallet: Wallet & Resource;
let providers: Awaited<ReturnType<typeof api.configureProviders>>;

// Contract deployed during "constructor" bench, reused for "proveOwnership"
let latestDeployedContract: DeployedCounterContract;

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('ZK Proof Generation Benchmark', () => {
  // ── Setup ──────────────────────────────────────────────────────────────────
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

    console.log(`\n  Config : ${config.constructor.name}`);
    console.log(`  Proof  : ${config.proofServer}`);
    console.log(`  Iters  : ${ITERATIONS}`);
    console.log(`  Log    : ${logPath}\n`);

    wallet = await api.buildWalletAndWaitForFunds(config, WALLET_SEED);
    providers = await api.configureProviders(wallet, config);
  }, 1000 * 60 * 45);

  afterAll(async () => {
    // Print the full results table after all suites finish
    printSummary();
    wallet.close();
  });

  // ── 1. constructor ─────────────────────────────────────────────────────────
  // Deploys a fresh zkAsset contract for each iteration.
  // This is the heaviest circuit: constructor validates the operator key
  // and writes all ledger fields in one shot.
  describe('1 · constructor (operator deploys zkAsset)', () => {
    it(`runs ${ITERATIONS} iterations`, async () => {
      const assetID = buildAssetID();
      // All-zero owner for bench purposes
      const owner = Buffer.alloc(32);

      for (let i = 0; i < ITERATIONS; i++) {
        console.log(`  [constructor] iteration ${i + 1}/${ITERATIONS}`);

        const policyIDBytes = utxoToBytes33(fakeTxid(i, 'ctor'), i % 256);

        latestDeployedContract = await api.deployZkAsset(
          providers,
          { operatorSecretKey: OPERATOR_SK },
          policyIDBytes,
          assetID,
          ASSET_NAME_TEXT,
          1n,
          owner,
          i,
        );
      }
    });
  });

  // ── 2. proveOwnership ──────────────────────────────────────────────────────
  // Calls proveOwnership on the last contract deployed above.
  // This is the primary user-facing proof: proves knowledge of assetOwnerSecretKey
  // without revealing it.
  //
  // Note: re-uses the same deployed contract across iterations.
  // proveOwnership is non-mutating so calling it multiple times is valid.
  describe('2 · proveOwnership (user proves asset ownership)', () => {
    it(`runs ${ITERATIONS} iterations`, async () => {
      if (!latestDeployedContract) {
        throw new Error('No deployed contract from constructor suite — run suites in order');
      }

      // Join with the asset owner key (must match the owner set at deploy time)
      // For the bench the owner is all-zeros so assetOwnerSecretKey = all-zeros
      const ownerContract = await api.joinContract(
        providers,
        latestDeployedContract.deployTxData.public.contractAddress,
        { assetOwnerSecretKey: Buffer.alloc(32) },
      );

      for (let i = 0; i < ITERATIONS; i++) {
        console.log(`  [proveOwnership] iteration ${i + 1}/${ITERATIONS}`);
        await api.proveOwnership(ownerContract, i);
      }
    });
  });

  // ── 3. burnAsset ───────────────────────────────────────────────────────────
  // Burns each contract after deploying it. burnAsset is terminal (sets
  // assetExpired=true) so each iteration needs its own fresh contract.
  // Deploy time is NOT counted in the burnAsset timing — we deploy first,
  // then measure only the burn call.
  describe('3 · burnAsset (operator burns zkAsset)', () => {
    it(`runs ${ITERATIONS} iterations`, async () => {
      const assetID = buildAssetID();
      const owner = Buffer.alloc(32);

      for (let i = 0; i < ITERATIONS; i++) {
        console.log(`  [burnAsset] iteration ${i + 1}/${ITERATIONS} — deploying fresh contract…`);

        const policyIDBytes = utxoToBytes33(fakeTxid(i, 'burn'), i % 256);

        // Deploy (this timing goes into 'constructor' bucket)
        const contract = await api.deployZkAsset(
          providers,
          { operatorSecretKey: OPERATOR_SK },
          policyIDBytes,
          assetID,
          ASSET_NAME_TEXT,
          1n,
          owner,
          // Use iteration offset so constructor entries are distinguishable
          ITERATIONS + i,
        );

        // Rejoin as operator for the burn
        const operatorContract = await api.joinContract(
          providers,
          contract.deployTxData.public.contractAddress,
          { operatorSecretKey: OPERATOR_SK },
        );

        console.log(`  [burnAsset] iteration ${i + 1}/${ITERATIONS} — burning…`);
        await api.burnAsset(operatorContract, i);
      }
    });
  });
});
