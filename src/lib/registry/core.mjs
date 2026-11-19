// @ts-nocheck — plain-ESM runtime module shared by the Vite app and the Node
// MCP server; it mirrors the shapes documented in src/lib/types, but is not
// itself TypeScript-checked (it must run untranspiled under bare Node).
/**
 * Celaut Registry — framework-agnostic data core.
 *
 * This is the SINGLE source of truth for the on-chain registry's read layer:
 * the Type NFT ids, the Explorer box search, the R9 parsers, and the `load_*`
 * functions. It is plain ESM with no Svelte/Vite/`reputation-system`
 * dependency, so it loads unchanged in three places:
 *
 *   - the Vite web app  (`src/lib/api.ts` re-exports the Type NFT ids here)
 *   - the MCP server     (`mcp/server.mjs` is a thin wrapper over `load_*`)
 *   - any plain Node script
 *
 * Keeping the logic here means the MCP server no longer re-implements (and
 * drifts from) what the app already knows. The only thing the app does NOT
 * share is the transport: in the browser it uses `reputation-system`'s
 * `searchBoxes`; here we inline the equivalent register search using
 * `@fleet-sdk/serializer` (a transitive dependency) so it runs under Node too.
 */
import { SColl, SByte } from '@fleet-sdk/serializer';

// ── Type NFT ids (single source of truth) ──────────────────────────────────
// PLACEHOLDER (not hex): the Objective type NFT is re-minted by the maintainer; paste the
// minted id here. Until then isHexId() fails and the load_* functions return [].
export const OBJECTIVE_TYPE_ID = 'REPLACE_WITH_MINTED_OBJECTIVE_TYPE_NFT_ID';

let activeObjectiveTypeId = OBJECTIVE_TYPE_ID;
/** Test hook: inject an objective type id while the real one is a placeholder. */
export function __setObjectiveTypeIdForTests(id = OBJECTIVE_TYPE_ID) {
  activeObjectiveTypeId = id;
}
export const BENCHMARK_TYPE_ID = 'f6480184daf3b7750a58e58319e12adc5266bd986eec0f57ac451c995a30f54d';
export const RESULT_TYPE_ID = '49b26dc06b1680769477264d2e8e9bf561005236cde3097630bffcff631b7aef';
export const COVERAGE_TYPE_ID = '1da6799e935cbb0fb14d359f06f23854c3d1bd509508948cc01b7b018dbbbdf5';

// Service info types — put a *fragment* of a service's celaut specification
// on-chain (keyed by service id in R5) so clients can read basic info (api,
// network, architecture, name…) WITHOUT downloading the whole service.
//   - service-data:v1     → functional spec fields: architecture / api / network
//   - service-metadata:v1 → descriptive metadata:    name / description / tags
// PLACEHOLDER ids until the real Type NFTs are minted; `isHexId` gates the
// queries to `[]` meanwhile (same pattern as the four types above).
export const SERVICE_DATA_TYPE_ID = 'celaut:service-data:v1';
export const SERVICE_METADATA_TYPE_ID = 'celaut:service-metadata:v1';

export const DEFAULT_EXPLORER_API =
  (typeof process !== 'undefined' && process.env && process.env.CELAUT_EXPLORER_API) ||
  'https://api.ergoplatform.com';

/**
 * Ergo-tree template hash of the reputation-proof contract. The Explorer's
 * `/boxes/unspent/search` endpoint REQUIRES this filter — omitting it returns
 * HTTP 400 (which previously made every query silently yield nothing).
 *
 * `reputation-system` compiles this at runtime from `reputation_proof.es`; we
 * bake the computed value here so the core stays browser-safe (no compiler /
 * `?raw` import). To recompute after a contract change:
 *   sha256(compile(reputation_proof.es, {version:1}).template)  (hex)
 */
export const REPUTATION_TREE_HASH =
  'e84b95d84a30df33aa258fe2b9d24c3e75e27a67c6453983c19703029112d147';

const LIMIT_PER_PAGE = 100;

export const isHexId = (v) => typeof v === 'string' && /^[0-9a-fA-F]{4,}$/.test(v);

/** Decode a hex string (Explorer Coll[Byte] renderedValue) to UTF-8 text. */
function hexToUtf8(hex) {
  if (!hex || typeof hex !== 'string') return '';
  const bytes = hexToBytes(hex);
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function hexToBytes(hex) {
  if (!hex || typeof hex !== 'string' || hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Strip the SColl[SByte] tag prefix to match the Explorer's renderedValue. */
function serializedToRendered(serialized) {
  if (serialized.startsWith('0e')) return serialized.substring(4);
  if (serialized.startsWith('04')) return serialized.substring(2);
  return serialized;
}

/**
 * Async-generator over unspent boxes matching a Type NFT (R4) and an optional
 * object pointer (R5), paging the Explorer's `/boxes/unspent/search` endpoint.
 */
export async function* searchBoxes(explorerUri, typeNftId, objectPointer, limit) {
  const registers = {};
  if (typeNftId) {
    registers.R4 = serializedToRendered(SColl(SByte, hexToBytes(typeNftId)).toHex());
  }
  if (objectPointer) {
    registers.R5 = serializedToRendered(SColl(SByte, hexToBytes(objectPointer)).toHex());
  }
  let offset = 0;
  let total = 0;
  while (true) {
    if (limit !== undefined && total >= limit) break;
    const fetchLimit =
      limit !== undefined ? Math.min(LIMIT_PER_PAGE, limit - total) : LIMIT_PER_PAGE;
    const url = `${explorerUri}/api/v1/boxes/unspent/search?offset=${offset}&limit=${fetchLimit}`;
    const body = { ergoTreeTemplateHash: REPUTATION_TREE_HASH, registers, assets: [] };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) return;
    const json = await res.json();
    const items = Array.isArray(json?.items) ? json.items : [];
    if (items.length === 0) return;
    yield items;
    total += items.length;
    offset += items.length;
    if (items.length < fetchLimit) return;
  }
}

export async function collectBoxes(typeNftId, objectPointer, limit = 100, explorerUri = DEFAULT_EXPLORER_API) {
  const all = [];
  for await (const batch of searchBoxes(explorerUri, typeNftId, objectPointer, limit)) {
    all.push(...batch);
  }
  return all;
}

export function parseR9(box) {
  try {
    // R9 is a Coll[Byte] rendered as hex — decode to UTF-8 before JSON.parse.
    const rendered = box?.additionalRegisters?.R9?.renderedValue || '';
    const decoded = hexToUtf8(rendered);
    return decoded ? JSON.parse(decoded) : {};
  } catch {
    return {};
  }
}

/** True when a value is a bare blake2b256 hex digest (32 bytes → 64 hex chars). */
export const looksLikeBlake2bHash = (v) =>
  typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim());

/**
 * Parse a Service* box R9 into one of two modes:
 *   - `source` : R9 is a bare blake2b256 hash → the real content lives off-chain
 *     in `sources` (the client resolves it via the source-application registry).
 *     Detected simply by the R9 payload being a hash string.
 *   - `inline` : R9 is a JSON spec fragment carried directly on-chain.
 * Returns `{ mode, sourceHash, content }` (content is `{}` in source mode).
 */
export function parseServiceInfoBox(box) {
  const rendered = box?.additionalRegisters?.R9?.renderedValue || '';
  const decoded = hexToUtf8(rendered).trim();
  if (looksLikeBlake2bHash(decoded)) {
    return { mode: 'source', sourceHash: decoded, content: {} };
  }
  let content = {};
  try {
    content = decoded ? JSON.parse(decoded) : {};
  } catch {
    content = {};
  }
  // A JSON-encoded string that is itself just a hash also means "source" mode.
  if (typeof content === 'string' && looksLikeBlake2bHash(content)) {
    return { mode: 'source', sourceHash: content.trim(), content: {} };
  }
  return {
    mode: 'inline',
    sourceHash: undefined,
    content: content && typeof content === 'object' ? content : {}
  };
}

export function deriveProfileId(box, parsed) {
  return (
    parsed.profile_id ||
    parsed.profileId ||
    box?.assets?.[0]?.tokenId ||
    box?.boxId ||
    ''
  );
}

// ── load_* (mirror src/lib/types shapes) ────────────────────────────────────

export async function loadObjectives(explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(activeObjectiveTypeId)) return [];
  const boxes = await collectBoxes(activeObjectiveTypeId, undefined, 100, explorerUri);
  return boxes.map((box) => {
    const parsed = parseR9(box);
    return {
      boxId: box.boxId,
      profileId: deriveProfileId(box, parsed),
      name: parsed.name || 'Unnamed Objective',
      prose: parsed.prose || '',
      formal: parsed.formal || '',
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      domain: parsed.domain || '',
      extendedObjectiveBoxIds: Array.isArray(parsed.extended_objective_boxes) ? parsed.extended_objective_boxes : [],
      sourceHash: parsed.source_hash
    };
  });
}

function parseCoverageBox(box) {
  const parsed = parseR9(box);
  return {
    boxId: box.boxId,
    profileId: deriveProfileId(box, parsed),
    serviceId: parsed.service_id || undefined
  };
}

export async function loadBenchmarks(objectiveBoxId, explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(BENCHMARK_TYPE_ID) || !isHexId(objectiveBoxId)) return [];
  const boxes = await collectBoxes(BENCHMARK_TYPE_ID, objectiveBoxId, 100, explorerUri);
  return boxes.map((box) => {
    const parsed = parseR9(box);
    return {
      id: box.boxId,
      profileId: deriveProfileId(box, parsed),
      objectiveBoxId,
      name: parsed.name || 'Unnamed Benchmark',
      description: parsed.description || '',
      caseDescriptors: Array.isArray(parsed.case_descriptors) ? parsed.case_descriptors : [],
      performanceMetrics: Array.isArray(parsed.performance_metrics) ? parsed.performance_metrics : [],
      sourceHash: parsed.source_hash
    };
  });
}

export async function loadResults(benchmarkId, explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(RESULT_TYPE_ID) || !isHexId(benchmarkId)) return [];
  const boxes = await collectBoxes(RESULT_TYPE_ID, benchmarkId, 100, explorerUri);
  return boxes.map((box) => {
    const parsed = parseR9(box);
    const rawCases = Array.isArray(parsed.data) ? parsed.data : [];
    return {
      id: box.boxId,
      profileId: deriveProfileId(box, parsed),
      benchmarkId,
      serviceId: parsed.service_id || '',
      data: rawCases.map((c) => ({
        caseMeta: Array.isArray(c?.case_meta) ? c.case_meta.map(Number) : [],
        metricsValues: Array.isArray(c?.metrics_values) ? c.metrics_values.map(Number) : []
      })),
      notes: parsed.notes || '',
      timestamp: parsed.timestamp || 0,
      sourceHash: parsed.source_hash
    };
  });
}

/**
 * Coverages for an objective — direct Coverage boxes PLUS service ids that
 * indirectly cover the objective via Results (results → benchmarks → objective).
 * Deduped by serviceId; direct coverages take precedence. Mirrors the
 * `loadCoverages` semantics in `src/lib/api.ts`.
 */
export async function loadCoverages(objectiveBoxId, explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(COVERAGE_TYPE_ID) || !isHexId(objectiveBoxId)) return [];
  const boxes = await collectBoxes(COVERAGE_TYPE_ID, objectiveBoxId, 100, explorerUri);
  const direct = boxes.map(parseCoverageBox);

  const benchmarks = await loadBenchmarks(objectiveBoxId, explorerUri);
  const resultLists = await Promise.all(benchmarks.map((b) => loadResults(b.id, explorerUri)));
  const results = resultLists.flat();

  const seen = new Set();
  const merged = [];
  for (const coverage of direct) {
    if (coverage.serviceId) {
      if (seen.has(coverage.serviceId)) continue;
      seen.add(coverage.serviceId);
    }
    merged.push(coverage);
  }
  for (const result of results) {
    const serviceId = result.serviceId;
    if (!serviceId || seen.has(serviceId)) continue;
    seen.add(serviceId);
    merged.push({ boxId: result.id, profileId: result.profileId, serviceId });
  }
  return merged;
}

/**
 * Coverages that target a Benchmark (R5 = the benchmark id). These are the services
 * that RUN the benchmark. A service with a Result in it is a solution of the objective
 * (see `loadCoverages`), not a runner, so it is deliberately not derived here.
 */
export async function loadBenchmarkCoverages(benchmarkId, explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(COVERAGE_TYPE_ID) || !isHexId(benchmarkId)) return [];
  const boxes = await collectBoxes(COVERAGE_TYPE_ID, benchmarkId, 100, explorerUri);
  const seen = new Set();
  const out = [];
  for (const box of boxes) {
    const coverage = { ...parseCoverageBox(box), benchmarkId };
    if (coverage.serviceId) {
      if (seen.has(coverage.serviceId)) continue;
      seen.add(coverage.serviceId);
    }
    out.push(coverage);
  }
  return out;
}

// ── Extended objectives ─────────────────────────────────────────────────────────
//
// An objective that lists another in `extended_objective_boxes` inherits that objective's
// coverages and benchmarks (the extender is the "parent" in the gallery and the
// extended one is nested under it). So a general objective extends the specific ones,
// and the services of the specific ones show up under the general one.

/**
 * The objectives that `boxId` extends, directly or not, nearest first. Cycle-safe: an objective
 * is visited once, `boxId` itself is never in the list, and an id that is not in
 * `objectives` is skipped.
 */
export function collectExtended(objectives, boxId) {
  const byBox = new Map(objectives.map((s) => [s.boxId, s]));
  const start = byBox.get(boxId);
  if (!start) return [];
  const seen = new Set([boxId]);
  const out = [];
  let level = [start];
  while (level.length) {
    const next = [];
    for (const objective of level) {
      for (const refId of objective.extendedObjectiveBoxIds || []) {
        if (seen.has(refId)) continue;
        seen.add(refId);
        const target = byBox.get(refId);
        if (!target) continue;
        out.push(target);
        next.push(target);
      }
    }
    level = next;
  }
  return out;
}

/**
 * The objectives that extend `boxId` directly (the other direction of `extended_objective_boxes`).
 */
export function collectExtenders(objectives, boxId) {
  return objectives.filter((s) => s.boxId !== boxId && (s.extendedObjectiveBoxIds || []).includes(boxId));
}

const cloneCoverage = (c) => ({ ...c });
const cloneBenchmark = (b) => ({
  ...b,
  results: (b.results || []).map((r) => ({ ...r })),
  ...(b.coverages ? { coverages: b.coverages.map(cloneCoverage) } : {})
});
const cloneObjective = (s) => ({
  ...s,
  tags: [...(s.tags || [])],
  extendedObjectiveBoxIds: [...(s.extendedObjectiveBoxIds || [])],
  coverages: (s.coverages || []).map(cloneCoverage),
  benchmarks: (s.benchmarks || []).map(cloneBenchmark)
});

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Merge the coverages and benchmarks of the extended objectives into each objective.
 * Idempotent and cycle-safe: own entries stay first, inherited ones are appended once
 * per box id, and each inherited entry says where it comes from (`inheritedFrom`, the
 * box id of the objective that owns it). This is the one implementation: the web app
 * (`api.ts`) and the MCP server use it.
 */
export function applyObjectiveInheritance(objectives) {
  const objectiveMap = new Map(objectives.map((objective) => [objective.boxId, objective]));
  const memo = new Map();
  const active = new Set();

  const resolve = (objective) => {
    const cached = memo.get(objective.boxId);
    if (cached) return cloneObjective(cached);
    if (active.has(objective.boxId)) return cloneObjective(objective);
    active.add(objective.boxId);

    const base = cloneObjective(objective);
    const related = (objective.extendedObjectiveBoxIds || [])
      .map((refId) => objectiveMap.get(refId))
      .filter(Boolean)
      .map(resolve);
    const from = (parent, item) => ({ ...item, inheritedFrom: item.inheritedFrom ?? parent.boxId });

    base.coverages = dedupeBy(
      [...base.coverages, ...related.flatMap((r) => r.coverages.map((c) => from(r, c)))],
      (coverage) => coverage.boxId
    ).map(cloneCoverage);
    base.benchmarks = dedupeBy(
      [...base.benchmarks, ...related.flatMap((r) => r.benchmarks.map((b) => from(r, b)))],
      (benchmark) => benchmark.id
    ).map(cloneBenchmark);
    base.resultCount = base.benchmarks.reduce((sum, b) => sum + (b.results || []).length, 0);

    active.delete(objective.boxId);
    memo.set(objective.boxId, base);
    return cloneObjective(base);
  };

  return objectives.map(resolve);
}

/** An objective with its own coverages, benchmarks (with results and runners) — no inheritance. */
async function loadOwnTree(objectiveBoxId, explorerUri) {
  const [coverages, benchmarks] = await Promise.all([
    loadCoverages(objectiveBoxId, explorerUri),
    loadBenchmarks(objectiveBoxId, explorerUri)
  ]);
  const withDetail = await Promise.all(
    benchmarks.map(async (b) => {
      const [results, runners] = await Promise.all([
        loadResults(b.id, explorerUri),
        loadBenchmarkCoverages(b.id, explorerUri)
      ]);
      return { ...b, results, coverages: runners };
    })
  );
  return { coverages, benchmarks: withDetail };
}

/**
 * An objective with its coverages, benchmarks, per-benchmark results and the services that run
 * each benchmark. With `inherit` (the default) the coverages and benchmarks of the objectives
 * that it extends are included (marked `inheritedFrom`), and the result says which objectives
 * those are (`extends`) and which objectives extend this one (`extendedBy`). Coverages of the
 * same service are listed once, the own one first.
 */
export async function loadObjectiveTree(objectiveBoxId, explorerUri = DEFAULT_EXPLORER_API, { inherit = true } = {}) {
  const objectives = await loadObjectives(explorerUri);
  const objective = objectives.find((s) => s.boxId === objectiveBoxId) || null;
  const own = await loadOwnTree(objectiveBoxId, explorerUri);
  if (!inherit || !objective) {
    return { objective, ...own, extends: [], extendedBy: objective ? collectExtenders(objectives, objectiveBoxId).map(brief) : [] };
  }

  const extended = collectExtended(objectives, objectiveBoxId);
  const trees = await Promise.all(extended.map((e) => loadOwnTree(e.boxId, explorerUri)));
  // Every objective of the chain keeps what it extends, so a chain of any depth inherits.
  const pool = [{ ...objective, ...own }, ...extended.map((e, i) => ({ ...e, ...trees[i] }))];
  const merged = applyObjectiveInheritance(pool)[0];
  return {
    objective,
    coverages: dedupeServices(merged.coverages),
    benchmarks: merged.benchmarks,
    extends: extended.map(brief),
    extendedBy: collectExtenders(objectives, objectiveBoxId).map(brief)
  };
}

const brief = (s) => ({ boxId: s.boxId, name: s.name });

/** The same service is once (the first one wins: the own coverage, then the nearest). */
function dedupeServices(coverages) {
  const seen = new Set();
  return coverages.filter((c) => {
    if (!c.serviceId) return true;
    if (seen.has(c.serviceId)) return false;
    seen.add(c.serviceId);
    return true;
  });
}

// ── Service info (metadata + data) ──────────────────────────────────────────
//
// Both are opinion boxes keyed by service id (R5) whose R9 carries a fragment of
// the service's celaut specification — either inline JSON or a blake2b hash that
// points at the full fragment in `sources`. This lets the objectives UI show a
// service's api/network/architecture/name without downloading the whole service.

/** Architecture string from a service-data spec fragment (celaut nests it under
 *  `container`, but tolerate a flat top-level `architecture` too). */
export function deriveArchitecture(content) {
  const c = content || {};
  if (c.container && typeof c.container === 'object' && typeof c.container.architecture === 'string') {
    return c.container.architecture;
  }
  return typeof c.architecture === 'string' ? c.architecture : undefined;
}

/**
 * Functional spec fragment for a service. R9 is a JSON object that MAY contain
 * `container`, `api` and `network` (with their respective sub-fields), or a
 * blake2b hash (source mode). Fields are kept as-is (no shape coercion) so the
 * UI/filters read whatever the publisher put on-chain; `architecture` is a
 * convenience derived from `container`.
 */
export async function loadServiceData(serviceId, explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(SERVICE_DATA_TYPE_ID) || !isHexId(serviceId)) return [];
  const boxes = await collectBoxes(SERVICE_DATA_TYPE_ID, serviceId, 100, explorerUri);
  return boxes.map((box) => {
    const info = parseServiceInfoBox(box);
    const c = info.content;
    return {
      boxId: box.boxId,
      profileId: deriveProfileId(box, c),
      serviceId,
      mode: info.mode,
      sourceHash: info.sourceHash,
      content: c,
      container: c.container && typeof c.container === 'object' ? c.container : undefined,
      api: c.api,
      network: c.network,
      architecture: deriveArchitecture(c)
    };
  });
}

/**
 * Descriptive metadata for a service. R9 is ARBITRARY JSON (or a blake2b hash in
 * source mode); the whole object is kept in `content`, with `name`/`description`/
 * `tags` surfaced when present for convenient display.
 */
export async function loadServiceMetadata(serviceId, explorerUri = DEFAULT_EXPLORER_API) {
  if (!isHexId(SERVICE_METADATA_TYPE_ID) || !isHexId(serviceId)) return [];
  const boxes = await collectBoxes(SERVICE_METADATA_TYPE_ID, serviceId, 100, explorerUri);
  return boxes.map((box) => {
    const info = parseServiceInfoBox(box);
    const c = info.content;
    return {
      boxId: box.boxId,
      profileId: deriveProfileId(box, c),
      serviceId,
      mode: info.mode,
      sourceHash: info.sourceHash,
      content: c,
      name: typeof c.name === 'string' ? c.name : undefined,
      description: typeof c.description === 'string' ? c.description : undefined,
      tags: Array.isArray(c.tags) ? c.tags : undefined
    };
  });
}
