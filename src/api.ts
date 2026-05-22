import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import * as Counter from '../managed/counter/contract/index.cjs';
import { type CounterPrivateState, witnesses } from './witnesses.js';
import { nativeToken, type CoinInfo, type TransactionId } from '@midnight-ntwrk/ledger';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { type FinalizedTxData } from '@midnight-ntwrk/midnight-js-types';
import { type Resource, WalletBuilder } from '@midnight-ntwrk/wallet';
import { type Wallet } from '@midnight-ntwrk/wallet-api';
import { getZswapNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { webcrypto } from 'crypto';
import { type Logger } from 'pino';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';

import { type Config, zkConfigPath, privateStateStoreName } from './config.js';
import {
  type CounterContract,
  type CounterProviders,
  type DeployedCounterContract,
  CounterPrivateStateId,
} from './common-types.js';
import {
  pendingSlot,
  createTimedProofProvider,
  createTimedWalletAndMidnightProvider,
} from './providers.js';
import { timings, type CircuitName } from './timings.js';

// @ts-ignore – required for Apollo WebSocket support
globalThis.WebSocket = WebSocket;

let logger: Logger;

export function setLogger(l: Logger): void {
  logger = l;
}

// ---------------------------------------------------------------------------
// Contract instance (singleton)
// ---------------------------------------------------------------------------
export const counterContractInstance: CounterContract = new Counter.Contract(witnesses);

// ---------------------------------------------------------------------------
// Provider setup
// ---------------------------------------------------------------------------
export const configureProviders = async (
  wallet: Wallet & Resource,
  config: Config,
): Promise<CounterProviders> => {
  const walletAndMidnightProvider = await createTimedWalletAndMidnightProvider(wallet, logger);
  const rawProofProvider = httpClientProofProvider(config.proofServer);

  return {
    privateStateProvider: levelPrivateStateProvider<typeof CounterPrivateStateId>({
      privateStateStoreName,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider<'proveOwnership' | 'burnAsset' | 'transferAsset'>(
      zkConfigPath,
    ),
    proofProvider: createTimedProofProvider(rawProofProvider, logger),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

// ---------------------------------------------------------------------------
// Timing wrapper — records a CallTiming entry for every circuit call
// ---------------------------------------------------------------------------
function recordTiming(operation: CircuitName, iteration: number, totalMs: number): void {
  timings.push({
    operation,
    iteration,
    circuitProofMs: pendingSlot.circuitProofMs,
    walletProofMs: pendingSlot.walletProofMs,
    totalCallTxMs: totalMs,
  });
  pendingSlot.circuitProofMs = 0;
  pendingSlot.walletProofMs = 0;
}

// ---------------------------------------------------------------------------
// Circuit calls
// ---------------------------------------------------------------------------

/** Deploy a new zkAsset contract (constructor circuit). */
export const deployZkAsset = async (
  providers: CounterProviders,
  privateState: CounterPrivateState,
  policyID: Uint8Array,
  assetID: Uint8Array,
  name: string,
  amount: bigint,
  owner: Uint8Array,
  iteration = 0,
): Promise<DeployedCounterContract> => {
  logger.info(`[BENCH] constructor — iteration ${iteration}`);
  const start = performance.now();

  const contract = await deployContract(providers, {
    contract: counterContractInstance,
    privateStateId: 'counterPrivateState',
    initialPrivateState: privateState,
    args: [policyID, assetID, name, BigInt.asUintN(64, BigInt(amount)), owner],
  });

  const totalMs = performance.now() - start;
  recordTiming('constructor', iteration, totalMs);

  logger.info(`[BENCH] constructor done — total=${totalMs.toFixed(0)} ms`);
  logger.info(`Deployed at: ${contract.deployTxData.public.contractAddress}`);

  return contract;
};

/** Deploy a new zkAsset contract WITHOUT recording timing (used as setup). */
export const deployZkAssetSilent = async (
  providers: CounterProviders,
  privateState: CounterPrivateState,
  policyID: Uint8Array,
  assetID: Uint8Array,
  name: string,
  amount: bigint,
  owner: Uint8Array,
): Promise<DeployedCounterContract> => {
  logger.info(`[BENCH] deploying contract (setup — not timed)`);

  const contract = await deployContract(providers, {
    contract: counterContractInstance,
    privateStateId: 'counterPrivateState',
    initialPrivateState: privateState,
    args: [policyID, assetID, name, BigInt.asUintN(64, BigInt(amount)), owner],
  });

  // Clear the slot so this deploy's numbers don't leak into the next timed call
  pendingSlot.circuitProofMs = 0;
  pendingSlot.walletProofMs = 0;

  logger.info(`Setup contract deployed at: ${contract.deployTxData.public.contractAddress}`);
  return contract;
};

/** Join an existing deployed contract (no proof generated). */
export const joinContract = async (
  providers: CounterProviders,
  contractAddress: string,
  privateState: CounterPrivateState,
): Promise<DeployedCounterContract> => {
  const contract = await findDeployedContract(providers, {
    contractAddress,
    contract: counterContractInstance,
    privateStateId: 'counterPrivateState',
    initialPrivateState: privateState,
  });
  logger.info(`Joined contract at: ${contract.deployTxData.public.contractAddress}`);
  return contract;
};

// ---------------------------------------------------------------------------
// Proof-only helpers
// These fire callTx without awaiting block confirmation.
// They return a Promise<number> that resolves as soon as the proof server
// responds — before the tx is submitted to the chain.
// ---------------------------------------------------------------------------

let proofSignal: ((ms: number) => void) | null = null;

/** Returns a promise that resolves with the proof time when the next proof completes. */
export function nextProofDone(): Promise<number> {
  return new Promise((resolve) => {
    proofSignal = resolve;
  });
}

/** Called by the timed proof provider after each proof completes. */
export function resolveProofSignal(ms: number): void {
  if (proofSignal) {
    proofSignal(ms);
    proofSignal = null;
  }
}

/** Call proveOwnership — times proof only, does NOT wait for block confirmation. */
export const proveOwnershipProofOnly = async (
  contract: DeployedCounterContract,
  iteration = 0,
): Promise<number> => {
  logger.info(`[BENCH] proveOwnership — iteration ${iteration}`);
  const proofDone = nextProofDone();

  contract.callTx.proveOwnership().catch((e) => {
    logger.warn(`proveOwnership tx failed after proof (expected): ${e}`);
  });

  const ms = await proofDone;
  timings.push({
    operation: 'proveOwnership',
    iteration,
    circuitProofMs: ms,
    walletProofMs: 0,
    totalCallTxMs: ms,
  });

  logger.info(`[BENCH] proveOwnership proof done — ${ms.toFixed(0)} ms`);
  return ms;
};

/** Call burnAsset — times proof only, does NOT wait for block confirmation. */
export const burnAssetProofOnly = async (
  contract: DeployedCounterContract,
  iteration = 0,
): Promise<number> => {
  logger.info(`[BENCH] burnAsset — iteration ${iteration}`);
  const proofDone = nextProofDone();

  contract.callTx.burnAsset().catch((e) => {
    logger.warn(`burnAsset tx failed after proof (expected): ${e}`);
  });

  const ms = await proofDone;
  timings.push({
    operation: 'burnAsset',
    iteration,
    circuitProofMs: ms,
    walletProofMs: 0,
    totalCallTxMs: ms,
  });

  logger.info(`[BENCH] burnAsset proof done — ${ms.toFixed(0)} ms`);
  return ms;
};

/** Read public ledger state from a deployed contract address. */
export const getContractLedgerState = async (
  providers: CounterProviders,
  contractAddress: ContractAddress,
) => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  return state != null ? Counter.ledger(state.data) : null;
};

// ---------------------------------------------------------------------------
// Wallet bootstrap
// ---------------------------------------------------------------------------

const waitForFunds = (wallet: Wallet) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.tap((state) => {
        const applyGap = state.syncProgress?.lag.applyGap ?? 0n;
        const sourceGap = state.syncProgress?.lag.sourceGap ?? 0n;
        logger.info(
          `Syncing — backend lag: ${sourceGap}, wallet lag: ${applyGap}, ` +
            `txs=${state.transactionHistory.length}`,
        );
      }),
      Rx.filter((state) => state.syncProgress?.synced === true),
      Rx.map((s) => s.balances[nativeToken()] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );

export const buildWalletAndWaitForFunds = async (
  { indexer, indexerWS, node, proofServer }: Config,
  seed: string,
): Promise<Wallet & Resource> => {
  const wallet = await WalletBuilder.buildFromSeed(
    indexer,
    indexerWS,
    proofServer,
    node,
    seed,
    getZswapNetworkId(),
    'info',
  );
  wallet.start();

  const state = await Rx.firstValueFrom(wallet.state());
  logger.info(`Wallet address: ${state.address}`);

  let balance = state.balances[nativeToken()];
  if (balance === undefined || balance === 0n) {
    logger.info('Waiting for tDUST funds…');
    balance = await waitForFunds(wallet);
  }
  logger.info(`Wallet balance: ${balance} tDUST`);
  return wallet;
};

export const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  webcrypto.getRandomValues(bytes);
  return bytes;
};