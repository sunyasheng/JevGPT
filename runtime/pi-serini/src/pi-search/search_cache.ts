import type { SearchBackendSearchHit } from "./searcher/contract/types";
import type { CachedSearch, SearchPage, ToolTimingBreakdown } from "./tool_types";

const MAX_CACHED_SEARCHES = 32;
const SEARCH_RESULTS_DEFAULT_LIMIT = 10;

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function formatSearchRequestSummary(cached: Pick<CachedSearch, "rawQuery">): string[] {
  return [`Plain query: ${JSON.stringify(cached.rawQuery)}`];
}

/** CMASS hybrid opts in: search IDs stay valid until the question ends instead of the last 32. */
export function questionLifetimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SEARCH_QUESTION_LIFETIME === "1";
}

export class SearchSessionStore {
  private readonly searchCache = new Map<string, CachedSearch>();
  private searchCounter = 0;
  private questionEpoch = 0;
  private questionOpen = true;

  constructor(private readonly maxCachedSearches = MAX_CACHED_SEARCHES) {}

  /** A question owns its rankings. IDs never alias a later question's IDs. */
  beginQuestion(): void {
    this.questionEpoch += 1;
    this.questionOpen = true;
    this.searchCache.clear();
  }

  endQuestion(): void {
    this.questionEpoch += 1;
    this.questionOpen = false;
    this.searchCache.clear();
  }

  captureQuestion(): number {
    this.assertQuestion(this.questionEpoch);
    return this.questionEpoch;
  }

  assertQuestion(epoch: number): void {
    if (!this.questionOpen || epoch !== this.questionEpoch)
      throw new Error("Search operation belongs to an ended question.");
  }

  createSearch(
    rawQuery: string,
    queryMode: string,
    results: SearchBackendSearchHit[],
    epoch = this.questionEpoch,
  ): CachedSearch {
    this.assertQuestion(epoch);
    this.searchCounter += 1;
    const searchId = `s${this.searchCounter}`;
    const cached: CachedSearch = {
      searchId,
      rawQuery,
      queryMode,
      results,
      createdAt: Date.now(),
    };
    this.searchCache.set(searchId, cached);
    this.evictOldSearches();
    return cached;
  }

  getSearch(searchId: string): CachedSearch | undefined {
    return this.searchCache.get(searchId);
  }

  private evictOldSearches(): void {
    while (this.searchCache.size > this.maxCachedSearches) {
      const oldestEntry = this.searchCache.entries().next().value as
        | [string, CachedSearch]
        | undefined;
      if (!oldestEntry) return;
      this.searchCache.delete(oldestEntry[0]);
    }
  }
}

export function buildSearchPage(
  cached: CachedSearch,
  offset: number,
  limit: number,
  timingMs?: ToolTimingBreakdown,
): SearchPage {
  const normalizedOffset = normalizePositiveInteger(offset, 1);
  const normalizedLimit = normalizePositiveInteger(limit, SEARCH_RESULTS_DEFAULT_LIMIT);
  const totalCached = cached.results.length;
  const startIndex = Math.min(normalizedOffset - 1, totalCached);
  const endIndex = Math.min(startIndex + normalizedLimit, totalCached);
  const pageResults = cached.results.slice(startIndex, endIndex).map((result, index) => ({
    ...result,
    rank: startIndex + index + 1,
  }));
  const returnedRankStart = pageResults.length > 0 ? pageResults[0].rank : 0;
  const returnedRankEnd = pageResults.length > 0 ? pageResults[pageResults.length - 1].rank : 0;
  const nextOffset = endIndex < totalCached ? endIndex + 1 : undefined;

  return {
    searchId: cached.searchId,
    rawQuery: cached.rawQuery,
    queryMode: cached.queryMode,
    totalCached,
    offset: normalizedOffset,
    limit: normalizedLimit,
    returnedRankStart,
    returnedRankEnd,
    nextOffset,
    timingMs,
    results: pageResults,
  };
}

export function formatSearchPageText(page: SearchPage): string {
  const searchSummary = formatSearchRequestSummary(page);
  if (page.results.length === 0) {
    return [
      `No cached hits remain for search_id=${page.searchId}.`,
      ...searchSummary,
      `Cached hits in this ranking: ${page.totalCached}`,
    ].join("\n");
  }

  const lines = [
    `Showing ranks ${page.returnedRankStart}-${page.returnedRankEnd} of ${page.totalCached} cached hits for search_id=${page.searchId}`,
    ...searchSummary,
    "",
  ];
  for (const result of page.results) {
    const scoreText = typeof result.score === "number" ? ` score=${result.score.toFixed(4)}` : "";
    lines.push(`${result.rank}. docid=${result.docid}${scoreText}`);
    if (result.title) {
      lines.push(`   Title: ${result.title}`);
    }
    if (result.snippet) {
      lines.push(`   Excerpt: ${result.snippet}`);
      if (result.snippetTruncated) {
        lines.push("   Excerpt preview truncated.");
      }
    } else {
      lines.push(
        "   Excerpt: (No snippet available from this backend. Use read_document(docid) to inspect the document.)",
      );
    }
    lines.push("");
  }
  if (page.nextOffset !== undefined) {
    lines.push(
      `Use read_search_results({"search_id":"${page.searchId}","offset":${page.nextOffset},"limit":${page.limit}}) to inspect more hits from this same ranking.`,
    );
  }
  lines.push("Use read_document(docid) to inspect a specific document in paginated chunks.");
  return lines.join("\n").trim();
}
