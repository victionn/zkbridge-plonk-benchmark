// ---------------------------------------------------------------------------
// Timing data store
// ---------------------------------------------------------------------------

export type CircuitName = 'constructor' | 'proveOwnership' | 'burnAsset';

export type CallTiming = {
  operation: CircuitName;
  iteration: number;
  /** Time the proof server HTTP call took (pure PLONK work). */
  circuitProofMs: number;
  /** Time wallet.proveTransaction() took (Zswap tx proof). */
  walletProofMs: number;
  /** Total time from callTx start to receiving FinalizedTxData (includes block wait). */
  totalCallTxMs: number;
};

/** All recorded timings, appended by api.ts as calls complete. */
export const timings: CallTiming[] = [];

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

export type Stats = {
  count: number;
  mean: number;
  min: number;
  max: number;
  stddev: number;
  p50: number;
  p90: number;
};

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, stddev: 0, p50: 0, p90: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  const p50 = sorted[Math.floor(n * 0.5)];
  const p90 = sorted[Math.floor(n * 0.9)];
  return {
    count: n,
    mean: +mean.toFixed(1),
    min: +sorted[0].toFixed(1),
    max: +sorted[n - 1].toFixed(1),
    stddev: +stddev.toFixed(1),
    p50: +p50.toFixed(1),
    p90: +p90.toFixed(1),
  };
}

export function printSummary(): void {
  const circuits: CircuitName[] = ['constructor', 'proveOwnership', 'burnAsset'];
  const fields: (keyof Omit<CallTiming, 'operation' | 'iteration'>)[] = [
    'circuitProofMs',
    'walletProofMs',
    'totalCallTxMs',
  ];

  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ZK PROOF GENERATION BENCHMARK RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  circuitProofMs  = pure PLONK time (HTTP call to proof-server :6300)');
  console.log('  walletProofMs   = Zswap tx proof inside Midnight wallet SDK');
  console.log('  totalCallTxMs   = full callTx round-trip incl. block confirmation');
  console.log('───────────────────────────────────────────────────────────────────\n');

  for (const circuit of circuits) {
    const rows = timings.filter((t) => t.operation === circuit);
    if (rows.length === 0) continue;

    console.log(`  ▶ ${circuit.toUpperCase()}  (n=${rows.length})`);

    const tableData: Record<string, Stats> = {};
    for (const field of fields) {
      tableData[field] = computeStats(rows.map((r) => r[field]));
    }
    console.table(tableData);

    // Raw per-iteration view
    console.log(`  Raw iterations:`);
    console.table(
      rows.map((r) => ({
        iter: r.iteration,
        circuitProofMs: r.circuitProofMs.toFixed(1),
        walletProofMs: r.walletProofMs.toFixed(1),
        totalCallTxMs: r.totalCallTxMs.toFixed(1),
      })),
    );
    console.log('');
  }
}
