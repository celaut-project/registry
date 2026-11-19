# Celaut Registry MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes the Celaut Registry on-chain registry as MCP tools. No tool in this
server creates or mutates state — it is safe to wire into any MCP client.

## Run

```bash
npm install
npm run mcp
```

The server speaks MCP over stdio. Point any MCP-aware client at
`node mcp/server.mjs` from the repo root.

Optional env: `CELAUT_EXPLORER_API` (defaults to `https://api.ergoplatform.com`).

## Connect a client

Running the server is not enough — an MCP client has to be told where to find
it. Use the absolute path to `mcp/server.mjs` in this repo.

**Claude Code / Claude Desktop (one-liner):**

```bash
claude mcp add celaut-registry -- node /path/to/registry/mcp/server.mjs
```

**Generic `mcpServers` config block** (Claude Desktop `claude_desktop_config.json`,
or any client that reads this shape):

```json
{
  "mcpServers": {
    "celaut-registry": {
      "command": "node",
      "args": ["/path/to/registry/mcp/server.mjs"],
      "env": {
        "CELAUT_EXPLORER_API": "https://api.ergoplatform.com"
      }
    }
  }
}
```

Replace `/path/to/registry` with the absolute path to your clone. The `env` block
is optional (the default explorer API is used when it is omitted). Run
`npm install` in the repo first so `node` can resolve the server's dependencies.

## Discovery flow — start with `load_objectives`

> Note: the Objective Type NFT id is a placeholder until it is minted, so until then `load_objectives` returns an empty list (and `load_objective_tree` returns `objective: null`). Set the id in `src/lib/registry/core.mjs` (`OBJECTIVE_TYPE_ID`).

Four of the five tools require an `objectiveBoxId` or `benchmarkId`, and **only
`load_objectives` takes no arguments**. There is no other entry point, so every
session starts by listing objectives and picking a box id from the results:

```
load_objectives                         (no args)  → [ { boxId, name, ... }, ... ]
   │  pick a boxId
   ▼
load_objective_tree { objectiveBoxId }      → objective + coverages + benchmarks + results
```

Worked example:

```jsonc
// 1. List objectives — the only argument-free tool.
load_objectives()
// → [
//     { "boxId": "3f1c9a...e7", "name": "Optimal XAU/BTC Performance",
//       "tags": ["trading", "gold"], "extendedObjectiveBoxIds": [] },
//     { "boxId": "8b204d...aa", "name": "Sat-sorter", "tags": ["utxo"] }
//   ]

// 2. Take a boxId from step 1 and load the full tree in one call.
load_objective_tree({ "objectiveBoxId": "3f1c9a...e7" })
// → {
//     "objective":      { "boxId": "3f1c9a...e7", "name": "Optimal XAU/BTC Performance", ... },
//     "coverages":  [ { "boxId": "c0ffee...", "serviceId": "9a77..." } ],
//     "benchmarks": [ { "id": "bench01...", "name": "12-month backtest",
//                       "results": [ { "id": "res01...", "serviceId": "9a77..." } ] } ]
//   }
```

If you need finer-grained access, the same `objectiveBoxId` feeds `load_coverages`
and `load_benchmarks`, and a `benchmarkId` from `load_benchmarks` feeds
`load_results`. `load_objective_tree` is just the convenience call that bundles all
of them.

## Architecture — one data layer, no duplication

`mcp/server.mjs` is a **thin wrapper**. It contains only the MCP tool registry
and handlers; it implements no chain logic of its own. Every `load_*` function,
the Type NFT ids, the Explorer box search, and the R9 parsers live once in the
shared, framework-agnostic core:

```
src/lib/registry/core.mjs   ← single source of truth (plain ESM, no Svelte/Vite)
├─ imported by  src/lib/api.ts      (the web app re-exports the Type NFT ids)
└─ imported by  mcp/server.mjs      (the MCP server maps load_* → tools)
```

Because the core is dependency-free ESM (only `@fleet-sdk/serializer` + global
`fetch`), it runs unchanged under both Vite and bare Node. The server therefore
**cannot drift** from the app: the load functions and ids are literally the same
module, not a hand-copied mirror.

> Note: the Type NFT ids are placeholders until real Type NFTs are minted, so
> these queries return empty arrays — the same behaviour as the web app's live
> mode. The web app's *transport* differs (it uses `reputation-system`'s
> `searchBoxes` in the browser); the core inlines the equivalent register search
> so it works under Node. Everything else — ids, parsing, `load_*` shapes — is
> shared.

## Tools

### `load_objectives`

List every registered Objective (problem marker).

- **Args:** none.
- **Returns:** array of
  `{ boxId, profileId, name, prose, formal, tags[], domain, extendedObjectiveBoxIds[], sourceHash? }`.

### `load_coverages`

Coverages for one Objective — the services that address it. Includes both **direct**
coverages (Coverage boxes pointing at the objective) and services that **indirectly**
cover it by appearing as the `service_id` of a Result under one of the objective's
Benchmarks. The list is deduped by `serviceId` (direct coverages win).

- **Args:** `{ objectiveBoxId: string }` (hex box id).
- **Returns:** array of `{ boxId, profileId, serviceId? }`.

### `load_benchmarks`

Benchmarks defined under one Objective (the "how to measure" specs).

- **Args:** `{ objectiveBoxId: string }` (hex box id).
- **Returns:** array of
  `{ id, profileId, objectiveBoxId, name, description, caseDescriptors[], performanceMetrics[], sourceHash? }`
  where `caseDescriptors[i] = { name, description }` and
  `performanceMetrics[i] = { name, description, higherIsBetter }`.

### `load_results`

Results submitted against one Benchmark.

- **Args:** `{ benchmarkId: string }` (hex Benchmark box id).
- **Returns:** array of
  `{ id, profileId, benchmarkId, serviceId, data[], notes, timestamp, sourceHash? }`
  where each `data[i] = { caseMeta: number[], metricsValues: number[] }` and
  indexes line up positionally with the parent Benchmark's `caseDescriptors`
  and `performanceMetrics`.

### `load_benchmark_coverages`

Coverages that target a Benchmark: the services that **run** it. A service with a
Result in the benchmark is a *solution* of the objective (it is in `load_coverages`), and it
is deliberately not derived here.

- **Args:** `{ benchmarkId: string }` (hex Benchmark box id).
- **Returns:** array of `{ boxId, profileId, serviceId?, benchmarkId }`.

### `load_objective_tree`

Convenience tool — returns an Objective plus its Coverages, Benchmarks, the Results under each
Benchmark and the services that run it, in a single nested payload.

- **Args:** `{ objectiveBoxId: string, inherit?: boolean }`. `inherit` is `true` by default.
- **Returns:** `{ objective, coverages[], benchmarks: (Benchmark & { results: Result[], coverages: Coverage[] })[], extends[], extendedBy[] }`.

#### Extended objectives

An objective lists the objectives it extends in `extended_objective_boxes`. The one that extends is the
*parent* (the web app shows it, and nests the extended one under it), and it **inherits the
coverages and benchmarks** of the objectives that it extends, through any depth. So a general
objective extends the specific ones, and the services of the specific ones are services of the
general one:

```
"Celaut Service Packing"  ──extends──▶  "…from a Dockerfile"   (services, benchmarks)
```

With `inherit` (the default), `load_objective_tree` includes those coverages and benchmarks.
Each inherited entry has `inheritedFrom`, the box id of the objective that owns it; an own entry
has none. A service is listed once (the own coverage first, then the nearest). `extends`
lists the objectives reached (`{ boxId, name }`, nearest first) and `extendedBy` the objectives
that extend this one directly. A cycle is cut where it closes. `inherit: false` gives only
what the objective itself has. `load_coverages`, `load_benchmarks` and `load_results` never
inherit: they are one objective's own boxes.

The inheritance is one function (`applyObjectiveInheritance` in `src/lib/registry/core.mjs`),
which the web app uses too.

## Explicitly omitted

The following data-layer functions create or mutate on-chain state and are
**not** exposed by this server: `createObjective`, `createCoverage`,
`createBenchmark`, `createResult`.
