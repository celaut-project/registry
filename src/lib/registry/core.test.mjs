import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  __setObjectiveTypeIdForTests,
  BENCHMARK_TYPE_ID,
  RESULT_TYPE_ID,
  COVERAGE_TYPE_ID,
  applyObjectiveInheritance,
  collectExtended,
  collectExtenders,
  loadObjectiveTree,
  loadBenchmarkCoverages
} from './core.mjs';

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const id = (c) => c.repeat(64);

// ── applyObjectiveInheritance / collectExtended (no network) ────────────────────

const objective = (boxId, extendedObjectiveBoxIds = [], coverages = [], benchmarks = []) => ({
  boxId,
  name: boxId,
  tags: [],
  extendedObjectiveBoxIds,
  coverages,
  benchmarks
});
const cov = (boxId, serviceId) => ({ boxId, serviceId, profileId: 'p' });
const bench = (id, results = []) => ({ id, name: id, results });

describe('collectExtended', () => {
  it('follows the chain, nearest first, once each, and not the objective itself', () => {
    const objectives = [objective('a', ['b', 'x']), objective('b', ['c']), objective('c', ['a', 'b'])];
    expect(collectExtended(objectives, 'a').map((s) => s.boxId)).toEqual(['b', 'c']);
  });
  it('is empty for an unknown objective', () => {
    expect(collectExtended([objective('a')], 'zzz')).toEqual([]);
  });
  it('collectExtenders is the other direction', () => {
    const objectives = [objective('gen', ['dock']), objective('dock'), objective('other', ['dock'])];
    expect(collectExtenders(objectives, 'dock').map((s) => s.boxId)).toEqual(['gen', 'other']);
  });
});

describe('applyObjectiveInheritance', () => {
  it('gives the extender the coverages and benchmarks of the extended objective, marked', () => {
    const [gen, dock] = applyObjectiveInheritance([
      objective('gen', ['dock'], [cov('g1', 'sg')]),
      objective('dock', [], [cov('d1', 'sd')], [bench('bd', [{ id: 'r' }])])
    ]);
    expect(gen.coverages.map((c) => [c.boxId, c.inheritedFrom])).toEqual([
      ['g1', undefined],
      ['d1', 'dock']
    ]);
    expect(gen.benchmarks.map((b) => [b.id, b.inheritedFrom])).toEqual([['bd', 'dock']]);
    expect(gen.resultCount).toBe(1);
    // The extended objective gets nothing from the extender.
    expect(dock.coverages.map((c) => c.boxId)).toEqual(['d1']);
  });

  it('keeps the owner through a chain', () => {
    const [a] = applyObjectiveInheritance([
      objective('a', ['b']),
      objective('b', ['c']),
      objective('c', [], [cov('c1', 'sc')])
    ]);
    expect(a.coverages).toEqual([{ ...cov('c1', 'sc'), inheritedFrom: 'c' }]);
  });

  it('survives a cycle and is idempotent', () => {
    const input = [objective('a', ['b'], [cov('a1')]), objective('b', ['a'], [cov('b1')])];
    const once = applyObjectiveInheritance(input);
    expect(once[0].coverages.map((c) => c.boxId).sort()).toEqual(['a1', 'b1']);
    expect(applyObjectiveInheritance(once)[0].coverages.map((c) => c.boxId).sort()).toEqual(['a1', 'b1']);
  });
});

// ── loadObjectiveTree against a fake Explorer ───────────────────────────────────

const GEN = id('a');
const DOCK = id('b');
const BENCH_D = id('c');
const SVC_D = id('1');
const SVC_RUN = id('2');

const box = (boxId, r9) => ({
  boxId,
  assets: [{ tokenId: id('e') }],
  additionalRegisters: { R9: { renderedValue: hex(JSON.stringify(r9)) } }
});

// The real objective type id is a placeholder until the NFT is minted: inject a test id.
const TEST_OBJECTIVE_TYPE_ID = 'c'.repeat(64);
__setObjectiveTypeIdForTests(TEST_OBJECTIVE_TYPE_ID);

/** boxes by `${R4}|${R5 or ''}` */
const REGISTRY = {
  [`${TEST_OBJECTIVE_TYPE_ID}|`]: [
    box(GEN, { name: 'general', extended_objective_boxes: [DOCK] }),
    box(DOCK, { name: 'dockerfile', extended_objective_boxes: [] })
  ],
  [`${COVERAGE_TYPE_ID}|${DOCK}`]: [box('cov-d', { service_id: SVC_D })],
  [`${BENCHMARK_TYPE_ID}|${DOCK}`]: [box(BENCH_D, { name: 'refs' })],
  [`${RESULT_TYPE_ID}|${BENCH_D}`]: [box('res-d', { service_id: SVC_D, data: [] })],
  // A service that RUNS the benchmark.
  [`${COVERAGE_TYPE_ID}|${BENCH_D}`]: [box('cov-run', { service_id: SVC_RUN, benchmark_id: BENCH_D })]
};

function fakeExplorer() {
  const fetchMock = vi.fn(async (_url, init) => {
    const { registers } = JSON.parse(init.body);
    const items = REGISTRY[`${registers.R4}|${registers.R5 ?? ''}`] ?? [];
    return { ok: true, json: async () => ({ items }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('loadObjectiveTree', () => {
  it('shows the services of the extended objectives under the extender', async () => {
    fakeExplorer();
    const tree = await loadObjectiveTree(GEN, 'http://explorer');
    expect(tree.objective.name).toBe('general');
    expect(tree.extends).toEqual([{ boxId: DOCK, name: 'dockerfile' }]);
    expect(tree.extendedBy).toEqual([]);
    // The service solves the specific objective and, by extension, the general one.
    expect(tree.coverages.map((c) => [c.serviceId, c.inheritedFrom])).toEqual([[SVC_D, DOCK]]);
    expect(tree.benchmarks.map((b) => [b.id, b.inheritedFrom])).toEqual([[BENCH_D, DOCK]]);
    expect(tree.benchmarks[0].results).toHaveLength(1);
  });

  it('keeps the runners of a benchmark apart from the solutions of the objective', async () => {
    fakeExplorer();
    const tree = await loadObjectiveTree(DOCK, 'http://explorer');
    expect(tree.coverages.map((c) => c.serviceId)).toEqual([SVC_D]);
    expect(tree.benchmarks[0].coverages.map((c) => [c.serviceId, c.benchmarkId])).toEqual([[SVC_RUN, BENCH_D]]);
    expect(tree.extendedBy).toEqual([{ boxId: GEN, name: 'general' }]);
  });

  it('inherit: false is only what the objective has', async () => {
    fakeExplorer();
    const tree = await loadObjectiveTree(GEN, 'http://explorer', { inherit: false });
    expect(tree.coverages).toEqual([]);
    expect(tree.benchmarks).toEqual([]);
    expect(tree.extends).toEqual([]);
  });

  it('loadBenchmarkCoverages gives the runners', async () => {
    fakeExplorer();
    const runners = await loadBenchmarkCoverages(BENCH_D, 'http://explorer');
    expect(runners.map((c) => c.serviceId)).toEqual([SVC_RUN]);
  });
});
