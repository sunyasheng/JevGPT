import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import type { SearchBackendSearchHit } from "./searcher/contract/types";

export type CachedSearch = {
  searchId: string;
  rawQuery: string;
  queryMode: string;
  results: SearchBackendSearchHit[];
  createdAt: number;
};

export type ToolTimingBreakdown = {
  searchRpcMs?: number;
  renderRpcMs?: number;
  readDocumentRpcMs?: number;
  serverInitMs?: number;
  serverUptimeMs?: number;
};

export type SearchPage = {
  searchId: string;
  rawQuery: string;
  queryMode: string;
  totalCached: number;
  offset: number;
  limit: number;
  returnedRankStart: number;
  returnedRankEnd: number;
  nextOffset?: number;
  timingMs?: ToolTimingBreakdown;
  results: Array<SearchBackendSearchHit & { rank: number }>;
};

export type SearchDetails = {
  searchId: string;
  rawQuery: string;
  queryMode: string;
  k: number;
  totalCached: number;
  returnedRankStart: number;
  returnedRankEnd: number;
  nextOffset?: number;
  retrievedDocids: string[];
  previewedDocids?: string[];
  timingMs?: ToolTimingBreakdown;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

export type ReadSearchResultsDetails = {
  searchId: string;
  rawQuery: string;
  queryMode: string;
  totalCached: number;
  offset: number;
  limit: number;
  returnedRankStart: number;
  returnedRankEnd: number;
  nextOffset?: number;
  retrievedDocids: string[];
  previewedDocids?: string[];
  timingMs?: ToolTimingBreakdown;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

export type ReadDocumentDetails = {
  docid: string;
  offset: number;
  limit: number;
  totalLines: number;
  returnedLineStart: number;
  returnedLineEnd: number;
  truncated: boolean;
  nextOffset?: number;
  timingMs?: ToolTimingBreakdown;
  outputTruncation?: TruncationResult;
  fullOutputPath?: string;
};
