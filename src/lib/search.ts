/**
 * Client-side search over the loaded Objective catalog. No backend: the catalog is
 * small (loaded once from the chain into the `objectives` store) and both indexes
 * below are cheap to rebuild whenever it changes.
 *
 * Two tiers:
 *   1. MiniSearch — the primary engine. `combineWith: 'AND'` requires every
 *      query term to match *some* field (fixing the old plain-substring filter,
 *      which only matched if the whole query appeared in one field), `prefix`
 *      gives as-you-type results, and per-token `fuzzy` catches minor typos.
 *   2. Fuse.js — a fallback used only when tier 1 finds nothing. It scores
 *      approximate matches over the whole string, which catches a typo too
 *      rough for MiniSearch's per-token fuzzy or a badly segmented word.
 */
import MiniSearch from 'minisearch';
import Fuse from 'fuse.js';
import type { Objective } from './types';

const SEARCH_FIELDS = ['name', 'prose', 'tags', 'domain'] as const;

function extractField(objective: Objective, field: string): string {
  const value = (objective as unknown as Record<string, unknown>)[field];
  if (Array.isArray(value)) return value.join(' ');
  return typeof value === 'string' ? value : '';
}

let miniIndex: MiniSearch<Objective> | null = null;
let fuseIndex: Fuse<Objective> | null = null;
let indexedObjectives: Objective[] = [];

/** (Re)build both indexes over `objectives`. Cheap enough to call on every load. */
export function buildSearchIndex(objectives: Objective[]): void {
  indexedObjectives = objectives;

  miniIndex = new MiniSearch<Objective>({
    idField: 'boxId',
    fields: [...SEARCH_FIELDS],
    extractField,
    searchOptions: {
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'AND',
      boost: { name: 3, tags: 2, domain: 1.5, prose: 1 }
    }
  });
  miniIndex.addAll(objectives);

  fuseIndex = new Fuse(objectives, {
    keys: [
      { name: 'name', weight: 0.5 },
      { name: 'tags', weight: 0.3 },
      { name: 'domain', weight: 0.15 },
      { name: 'prose', weight: 0.05 }
    ],
    threshold: 0.4,
    ignoreLocation: true
  });
}

/**
 * Tier 2 fallback: Fuse.js matches a whole query string approximately, which on
 * its own drops the AND-across-terms guarantee tier 1 gives (a query like
 * "markdown ergo" would otherwise pass just because "markdown" alone scores
 * well). Searching each term separately and intersecting keeps "every term has
 * to match somewhere" while still tolerating a rough typo per term.
 */
function fuseFallback(query: string): Objective[] {
  if (!fuseIndex) return [];
  const terms = query.split(/\s+/).filter(Boolean);

  let matched: Set<Objective> | null = null;
  for (const term of terms) {
    const termMatches = new Set(fuseIndex.search(term).map((result) => result.item));
    if (matched === null) {
      matched = termMatches;
    } else {
      const intersection = new Set<Objective>();
      for (const objective of matched) {
        if (termMatches.has(objective)) intersection.add(objective);
      }
      matched = intersection;
    }
    if (matched.size === 0) return [];
  }
  return matched ? Array.from(matched) : [];
}

/** Search the last-built index. An empty/blank query returns every objective. */
export function searchObjectives(query: string): Objective[] {
  const trimmed = query.trim();
  if (!trimmed || !miniIndex || !fuseIndex) return indexedObjectives;

  const hits = miniIndex.search(trimmed);
  if (hits.length > 0) {
    const byId = new Map(indexedObjectives.map((objective) => [objective.boxId, objective]));
    return hits.map((hit) => byId.get(String(hit.id))).filter((objective): objective is Objective => Boolean(objective));
  }

  return fuseFallback(trimmed);
}
