import * as Counter from '../managed/counter/contract/index.cjs';
import { type CounterPrivateState } from './witnesses.js';
import type { ImpureCircuitId, MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';

export type CounterCircuits = ImpureCircuitId<Counter.Contract<CounterPrivateState>>;

export const CounterPrivateStateId = 'counterPrivateState';

export type CounterProviders = MidnightProviders<
  CounterCircuits,
  typeof CounterPrivateStateId,
  CounterPrivateState
>;

export type CounterContract = Counter.Contract<CounterPrivateState>;

export type DeployedCounterContract =
  | DeployedContract<CounterContract>
  | FoundContract<CounterContract>;
