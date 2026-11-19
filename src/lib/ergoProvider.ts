/**
 * Real Ergo Explorer API data provider.
 * Wraps the existing API functions into the DataProvider interface.
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
import { loadObjectives as apiLoadObjectives, loadCoverages as apiLoadCoverages, loadBenchmarkCoverages as apiLoadBenchmarkCoverages, loadBenchmarks as apiLoadBenchmarks, loadResults as apiLoadResults } from './api';
import { ApiError } from './types';
import { create_profile, create_opinion } from 'reputation-system';
import type { RPBox } from 'source-application';
import {
  OBJECTIVE_TYPE_ID,
  COVERAGE_TYPE_ID,
  BENCHMARK_TYPE_ID,
  RESULT_TYPE_ID,
  SERVICE_DATA_TYPE_ID,
  SERVICE_METADATA_TYPE_ID,
  STRICT_DEFINITION_TYPE_ID,
  DEPENDENCY_TRUST_FRAMEWORK_TYPE_ID
} from './api';

const LOCKED: boolean = true; // For now, we lock the boxes we create. This can be changed later if needed. Esto evita que los boxes puedan actualizarse, pues cada entidad puede ser referenciada por otra, y una actualización de una entidad modificaría su propio identificador (id de la caja), ademas de que no queremos que las entidades puedan ser modificadas una vez creadas, para mantener la integridad de la reputación.

function getMainBox(inputMainBox: unknown, entityName: string): RPBox {
  if (!inputMainBox) {
    throw new ApiError(
      `A main reputation box is required to create ${entityName} on-chain.`,
      'MISSING_MAIN_BOX'
    );
  }

  return inputMainBox as RPBox;
}

class ErgoDataProvider implements DataProvider {
  async loadObjectives(): Promise<Objective[]> {
    // LIGHTWEIGHT initial load. `apiLoadObjectives()` returns objective boxes with
    // their names/tags/domain/prose/profileId/boxId already populated (and
    // EMPTY coverages/benchmarks). That is everything the gallery, search and
    // cards need to render — so we no longer eagerly fan out to the explorer
    // to hydrate every objective's coverages/benchmarks/results up front. Instead
    // each objective is hydrated on demand via `hydrateObjective()` when the user
    // actually searches for or opens it.
    //
    // NOTE: applyObjectiveInheritance is intentionally SKIPPED here. It merges
    // inherited coverages/benchmarks from extended objectives, which requires the
    // per-objective relations to already be hydrated. In the lightweight path
    // there is nothing to merge yet, so running it would be a no-op at best;
    // inheritance is (re)applied lazily per objective during hydration instead.
    return apiLoadObjectives();
  }

  /**
   * Hydrate ONE objective's heavy relations on demand: its coverages, benchmarks,
   * and each benchmark's results + benchmark-coverages. Idempotent — an objective
   * that is already hydrated returns immediately.
   */
  async hydrateObjective(objective: Objective): Promise<void> {
    if (objective.__hydrated) return;

    const [coverages, benchmarks] = await Promise.all([
      apiLoadCoverages(objective.boxId),
      apiLoadBenchmarks(objective.boxId)
    ]);

    await Promise.all(
      benchmarks.map(async (benchmark) => {
        const [results, benchmarkCoverages] = await Promise.all([
          apiLoadResults(benchmark.id),
          apiLoadBenchmarkCoverages(benchmark.id)
        ]);
        benchmark.results = results;
        benchmark.coverages = benchmarkCoverages;
      })
    );

    objective.coverages = coverages;
    objective.benchmarks = benchmarks;
    objective.resultCount = benchmarks.reduce(
      (sum, benchmark) => sum + benchmark.results.length,
      0
    );
    objective.__hydrated = true;
  }

  async loadCoverages(objectiveBoxId: string): Promise<Coverage[]> {
    return apiLoadCoverages(objectiveBoxId);
  }

  async loadBenchmarkCoverages(benchmarkId: string): Promise<Coverage[]> {
    return apiLoadBenchmarkCoverages(benchmarkId);
  }

  async loadBenchmarks(objectiveBoxId: string): Promise<Benchmark[]> {
    return apiLoadBenchmarks(objectiveBoxId);
  }

  async loadResults(benchmarkId: string): Promise<Result[]> {
    return apiLoadResults(benchmarkId);
  }

  async createObjective(input: ObjectiveCreationInput): Promise<string> {
    // Nota: create_opinion suele requerir un tokenAmount (usamos reputationSupply o 1 por defecto)
    // y, opcionalmente, un objeto al que hace referencia. Si es un objetivo raíz, se suele apuntar a sí misma o usar un ID vacío.
    if (!/^[0-9a-fA-F]{4,}$/.test(OBJECTIVE_TYPE_ID)) {
      throw new Error('OBJECTIVE_TYPE_ID is still a placeholder; mint the Objective Type NFT and set it in src/lib/registry/core.mjs');
    }
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      OBJECTIVE_TYPE_ID,
      '', // ID del objetivo. Un objetivo no apunta a nada en concreto.
      true,
      {
        name: input.name,
        prose: input.prose,
        formal: input.formal ?? '',
        tags: input.tags,
        domain: input.domain,
        extended_objective_boxes: input.extendedObjectiveBoxIds,
        source_hash: input.sourceHash ?? null
      },
      LOCKED,
      // create_opinion requiere una RPBox. Si no viene en el input, se necesita una alternativa global o lanzar error.
      getMainBox((input as any).mainBox, 'objective')
    );

    if (!txId) {
      throw new ApiError('Failed to create objective on-chain.', 'CREATE_OBJECTIVE_FAILED');
    }

    return txId;
  }

  async createCoverage(input: CoverageCreationInput): Promise<string> {
    // A coverage may target either the objective (default) or one of its
    // benchmarks. When `benchmarkId` is set, the opinion points at the
    // benchmark box and records the benchmark id in its payload.
    const targetBenchmark = !!input.benchmarkId;
    const objectPointer = targetBenchmark ? input.benchmarkId! : input.objectiveBoxId;
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      COVERAGE_TYPE_ID,
      objectPointer,
      true,
      {
        objective_box_id: input.objectiveBoxId,
        benchmark_id: input.benchmarkId ?? null,
        service_id: input.serviceId ?? null
      },
      LOCKED,
      getMainBox(input.mainBox, 'coverage')
    );

    if (!txId) {
      throw new ApiError('Failed to create coverage on-chain.', 'CREATE_COVERAGE_FAILED');
    }

    return txId;
  }

  async createBenchmark(input: BenchmarkCreationInput): Promise<string> {
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      BENCHMARK_TYPE_ID,
      input.objectiveBoxId,
      true,
      {
        objective_box_id: input.objectiveBoxId,
        name: input.name,
        description: input.description,
        case_descriptors: input.caseDescriptors.map((d) => ({
          name: d.name,
          description: d.description
        })),
        // Emit the canonical snake_case `higher_is_better` declared by the
        // benchmark Type-NFT schema so external tooling (and our own reader)
        // resolve the metric direction instead of seeing `undefined`.
        performance_metrics: input.performanceMetrics.map((m) => ({
          name: m.name,
          description: m.description,
          higher_is_better: m.higherIsBetter
        })),
        source_hash: input.sourceHash ?? null
      },
      LOCKED,
      getMainBox(input.mainBox, 'benchmark')
    );

    if (!txId) {
      throw new ApiError('Failed to create benchmark on-chain.', 'CREATE_BENCHMARK_FAILED');
    }

    return txId;
  }

  async createResult(input: ResultCreationInput): Promise<string> {
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      RESULT_TYPE_ID,
      input.benchmarkId,
      true,
      {
        benchmark_id: input.benchmarkId,
        service_id: input.serviceId,
        // The performance tensor: an array of CaseExecutionData, each with
        // caseMeta (positional to caseDescriptors) and metricsValues
        // (positional to performanceMetrics).
        data: input.data.map((c) => ({
          case_meta: c.caseMeta,
          metrics_values: c.metricsValues
        })),
        notes: input.notes,
        timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
        source_hash: input.sourceHash ?? null
      },
      LOCKED,
      getMainBox(input.mainBox, 'result')
    );

    if (!txId) {
      throw new ApiError('Failed to create result on-chain.', 'CREATE_RESULT_FAILED');
    }

    return txId;
  }

  async createServiceData(input: ServiceInfoCreationInput): Promise<string> {
    // R5 = service id; R9 = the spec fragment (object) OR a blake2b hash string
    // pointing at the content in `sources`. create_opinion accepts either.
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      SERVICE_DATA_TYPE_ID,
      input.serviceId,
      true,
      input.content,
      LOCKED,
      getMainBox(input.mainBox, 'service data')
    );

    if (!txId) {
      throw new ApiError('Failed to create service data on-chain.', 'CREATE_SERVICE_DATA_FAILED');
    }

    return txId;
  }

  async createServiceMetadata(input: ServiceInfoCreationInput): Promise<string> {
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      SERVICE_METADATA_TYPE_ID,
      input.serviceId,
      true,
      input.content,
      LOCKED,
      getMainBox(input.mainBox, 'service metadata')
    );

    if (!txId) {
      throw new ApiError('Failed to create service metadata on-chain.', 'CREATE_SERVICE_METADATA_FAILED');
    }

    return txId;
  }

  async createStrictDefinition(input: StrictDefinitionCreationInput): Promise<string> {
    // Strict Definitions are self-contained (R5 empty — no object pointer).
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      STRICT_DEFINITION_TYPE_ID,
      '',
      true,
      input.content,
      LOCKED,
      getMainBox(input.mainBox, 'strict definition')
    );

    if (!txId) {
      throw new ApiError('Failed to create strict definition on-chain.', 'CREATE_STRICT_DEFINITION_FAILED');
    }

    return txId;
  }

  async createTrustFramework(input: TrustFrameworkCreationInput): Promise<string> {
    // DTF boxes point at their Strict Definition via R5 (object_pointer).
    const txId = await create_opinion(
      'https://api.ergoplatform.com',
      input.tokenAmount ?? 1,
      DEPENDENCY_TRUST_FRAMEWORK_TYPE_ID,
      input.strictDefinitionBoxId,
      true,
      input.content,
      LOCKED,
      getMainBox(input.mainBox, 'trust framework')
    );

    if (!txId) {
      throw new ApiError('Failed to create trust framework on-chain.', 'CREATE_TRUST_FRAMEWORK_FAILED');
    }

    return txId;
  }
}

/** Singleton Ergo data provider instance. */
export const ergoProvider = new ErgoDataProvider();
