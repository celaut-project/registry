/**
 * Svelte stores for Celaut Registry app state.
 * Svelte 4 — uses writable/derived (NOT runes).
 */

import { writable, derived } from 'svelte/store';
import type { Objective, Benchmark, ActiveTab } from './types';
import { buildSearchIndex, searchObjectives } from './search';

// ── Core Stores ──────────────────────────────────────────────────────────────

/** All loaded objectives (from chain or demo fallback). */
export const objectives = writable<Objective[]>([]);

/** Currently selected objective for detail view, or null for gallery. */
export const selectedObjective = writable<Objective | null>(null);

/** Currently selected benchmark for detail view, or null. */
export const selectedBenchmark = writable<Benchmark | null>(null);

/** Current search query for filtering objectives. */
export const searchQuery = writable<string>('');

/** Active navigation tab. */
export const activeTab = writable<ActiveTab>('gallery');

/** Loading state for objective fetching. */
export const loading = writable<boolean>(true);

/** Error message if objective loading fails. */
export const error = writable<string | null>(null);

// ── Derived Stores ───────────────────────────────────────────────────────────

/**
 * Filtered objectives based on the current search query, via `search.ts`'s
 * MiniSearch (primary) + Fuse.js (typo fallback) indexes. The index is only
 * rebuilt when `$objectives` is a new array reference — i.e. an actual reload, not
 * every `searchQuery` keystroke.
 */
let lastIndexedObjectives: Objective[] | null = null;

export const filteredObjectives = derived(
  [objectives, searchQuery],
  ([$objectives, $searchQuery]) => {
    if ($objectives !== lastIndexedObjectives) {
      buildSearchIndex($objectives);
      lastIndexedObjectives = $objectives;
    }
    return searchObjectives($searchQuery);
  }
);

/** Total results across all objectives. */
export const totalResults = derived(objectives, ($objectives) =>
  $objectives.reduce((sum, s) => sum + s.resultCount, 0)
);

/**
 * Profile id selected for the profile-detail view, or null for no selection.
 * Set when a user clicks any ProfileAvatar (or arrives via the `?profile=`
 * URL parameter) and consumed by App.svelte to render the profile screen.
 */
export const viewedProfileId = writable<string | null>(null);

/**
 * Network box id for the ?network= page, or null.
 * Set to a box id to view/manage a specific network definition,
 * or 'new' to open the create-network form.
 */
export const viewedNetworkId = writable<string | null>(null);

/**
 * Service id for the ?service= page, or null.
 */
export const viewedServiceId = writable<string | null>(null);

/**
 * Where to return when leaving the network page. Null when the user
 * navigated directly (e.g. shared URL).
 */
export const networkPageReturn = writable<{ type: 'service'; serviceId: string } | { type: 'serviceForm' } | null>(null);

/** Preserved service data form state — survives navigation to the network page. */
export interface ServiceDataFormState {
  serviceId: string;
  prose: string;
  containerArchitecture: string;
  apiSlots: Array<{ port: string; transport: string[]; protocol: string[] }>;
  networkItems: Array<{ type: 'inline'; tags: string[] } | { type: 'ref'; boxId: string }>;
  metadataJson: string;
  kind: 'data' | 'metadata';
}

export const serviceDataFormState = writable<ServiceDataFormState | null>(null);
