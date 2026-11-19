/**
 * In-memory mock database for demo mode.
 * Mirrors the Ergo API functions with local data.
 * Pre-populated with getDemoObjectives() data.
 */

import type { DataProvider } from './dataProvider';
import type {
  Objective,
  Coverage,
  Benchmark,
  Result,
  ObjectiveCreationInput,
  CoverageCreationInput,
  BenchmarkCreationInput,
  ResultCreationInput,
  ServiceInfoCreationInput,
  StrictDefinitionCreationInput,
  TrustFrameworkCreationInput
} from './types';
import { applyObjectiveInheritance, getDemoObjectives } from './api';

class MockDatabase implements DataProvider {
  private objectives: Objective[];
  private writeCounter = 0;

  constructor() {
    this.objectives = getDemoObjectives();
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  private createId(prefix: string): string {
    this.writeCounter += 1;
    const entropy = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return `${prefix}-${entropy}-${this.writeCounter}`;
  }

  private createTxId(kind: string): string {
    return `demo-${kind}-${Date.now().toString(36)}-${this.writeCounter}`;
  }

  private syncObjectiveCounters(objective: Objective): void {
    objective.resultCount = objective.benchmarks.reduce((sum, benchmark) => sum + benchmark.results.length, 0);
  }

  private findObjective(boxId: string): Objective | undefined {
    return this.objectives.find((objective) => objective.boxId === boxId);
  }


  private getProfileId(mainBox: unknown): string {
    const profileId = (mainBox as { token_id?: string } | undefined)?.token_id;
    return profileId || this.createId('profile');
  }

  private findBenchmark(benchmarkId: string): { objective: Objective; benchmark: Benchmark } | undefined {
    for (const objective of this.objectives) {
      const benchmark = objective.benchmarks.find((item) => item.id === benchmarkId);
      if (benchmark) {
        return { objective, benchmark };
      }
    }
    return undefined;
  }

  async loadObjectives(): Promise<Objective[]> {
    // Return a deep copy to prevent mutation
    return applyObjectiveInheritance(this.clone(this.objectives));
  }

  async hydrateObjective(_objective: Objective): Promise<void> {
    // No-op: demo objectives ship fully populated (getDemoObjectives), so there is
    // nothing to lazily fetch.
  }

  async loadCoverages(objectiveBoxId: string): Promise<Coverage[]> {
    const objective = applyObjectiveInheritance(this.clone(this.objectives)).find(s => s.boxId === objectiveBoxId);
    if (!objective) return [];
    return this.clone(objective.coverages);
  }

  async loadBenchmarks(objectiveBoxId: string): Promise<Benchmark[]> {
    const objective = applyObjectiveInheritance(this.clone(this.objectives)).find(s => s.boxId === objectiveBoxId);
    if (!objective) return [];
    return this.clone(objective.benchmarks);
  }

  async loadBenchmarkCoverages(benchmarkId: string): Promise<Coverage[]> {
    const match = this.findBenchmark(benchmarkId);
    if (!match) return [];
    return this.clone(match.benchmark.coverages ?? []);
  }

  async loadResults(benchmarkId: string): Promise<Result[]> {
    for (const objective of this.objectives) {
      for (const bench of objective.benchmarks) {
        if (bench.id === benchmarkId) {
          return this.clone(bench.results);
        }
      }
    }
    return [];
  }

  async createObjective(input: ObjectiveCreationInput): Promise<string> {
    const boxId = this.createId('objective');
    const profileId = this.getProfileId(input.mainBox);
    const objective: Objective = {
      boxId,
      profileId,
      name: input.name,
      prose: input.prose,
      formal: input.formal ?? '',
      tags: [...input.tags],
      domain: input.domain,
      extendedObjectiveBoxIds: [...input.extendedObjectiveBoxIds],
      coverages: [],
      benchmarks: [],
      resultCount: 0,
      reputation: 0,
      sourceHash: input.sourceHash
    };

    this.objectives.push(objective);
    return this.createTxId('objective');
  }

  async createCoverage(input: CoverageCreationInput): Promise<string> {
    const profileId = this.getProfileId(input.mainBox);

    // Benchmark-targeted coverage: attach to the benchmark, not the objective.
    if (input.benchmarkId) {
      const match = this.findBenchmark(input.benchmarkId);
      if (!match) {
        throw new Error(`Benchmark ${input.benchmarkId} not found.`);
      }
      if (!match.benchmark.coverages) match.benchmark.coverages = [];
      match.benchmark.coverages.push({
        boxId: this.createId('cov'),
        profileId,
        serviceId: input.serviceId,
        benchmarkId: input.benchmarkId,
        reputation: 0
      });
      return this.createTxId('coverage');
    }

    const objective = this.findObjective(input.objectiveBoxId);
    if (!objective) {
      throw new Error(`Objective ${input.objectiveBoxId} not found.`);
    }

    objective.coverages.push({
      boxId: this.createId('cov'),
      profileId,
      serviceId: input.serviceId,
      reputation: 0
    });

    return this.createTxId('coverage');
  }

  async createBenchmark(input: BenchmarkCreationInput): Promise<string> {
    const objective = this.findObjective(input.objectiveBoxId);
    if (!objective) {
      throw new Error(`Objective ${input.objectiveBoxId} not found.`);
    }

    const profileId = this.getProfileId(input.mainBox);
    objective.benchmarks.push({
      id: this.createId('bench'),
      profileId,
      objectiveBoxId: input.objectiveBoxId,
      name: input.name,
      description: input.description,
      caseDescriptors: [...(input.caseDescriptors ?? [])],
      performanceMetrics: [...(input.performanceMetrics ?? [])],
      results: [],
      coverages: [],
      reputation: 0,
      sourceHash: input.sourceHash
    });

    this.syncObjectiveCounters(objective);
    return this.createTxId('benchmark');
  }

  async createResult(input: ResultCreationInput): Promise<string> {
    const match = this.findBenchmark(input.benchmarkId);
    if (!match) {
      throw new Error(`Benchmark ${input.benchmarkId} not found.`);
    }

    const profileId = this.getProfileId(input.mainBox);
    match.benchmark.results.push({
      id: this.createId('res'),
      profileId,
      benchmarkId: input.benchmarkId,
      serviceId: input.serviceId,
      data: input.data.map((c) => ({
        caseMeta: [...c.caseMeta],
        metricsValues: [...c.metricsValues]
      })),
      notes: input.notes,
      timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
      sourceHash: input.sourceHash,
      reputation: 0
    });

    this.syncObjectiveCounters(match.objective);
    return this.createTxId('result');
  }

  // Service info has no demo gallery yet (the ServiceInfoCard reads live chain
  // data directly), so demo publishing is a no-op that just returns a tx id —
  // enough to satisfy the DataProvider contract and exercise the submit UI.
  async createServiceData(_input: ServiceInfoCreationInput): Promise<string> {
    return this.createTxId('service-data');
  }

  async createServiceMetadata(_input: ServiceInfoCreationInput): Promise<string> {
    return this.createTxId('service-metadata');
  }

  async createStrictDefinition(_input: StrictDefinitionCreationInput): Promise<string> {
    return this.createTxId('strict-definition');
  }

  async createTrustFramework(_input: TrustFrameworkCreationInput): Promise<string> {
    return this.createTxId('trust-framework');
  }

  /** Reset the database to initial demo data. */
  reset(): void {
    this.objectives = getDemoObjectives();
  }
}

/** Singleton mock database instance. */
export const mockDb = new MockDatabase();
