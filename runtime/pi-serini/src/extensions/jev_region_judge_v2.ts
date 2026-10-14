import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FIND_LIMITS,
  makeRequest,
  validateAnswers,
  type Region,
  type FindResponse,
} from "./jev_find_v1";

export type RegionOutcome<T = ReturnType<typeof validateAnswers>> =
  | { region: Region; ok: true; results: T }
  | { region: Region; ok: false; error: string };
/** Task semantics vary; transport, caching and bounded token recovery are shared. */
export type RegionJudgePolicy<T> = {
  makeRequest: (docid: string, region: Region, queries: string[], model: string) => unknown;
  validateAnswers: (body: any, region: Region, queries: string[]) => T;
};
export type TokenRecoveryOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  observe?: (row: Record<string, any>) => void;
  remainingTimeMs?: () => number;
  timeoutMs?: number;
  reserveMs?: number;
  maxSplitDepth?: number;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const render = (blocks: Region["blocks"]) => blocks.map((b) => `${b.id}| ${b.text}`).join("\n");

/** Split at a complete numbered block, near half the UTF-8 bytes; never renumber or truncate. */
export function bisectRegion(region: Region): [Region, Region] | undefined {
  assert.equal(region.state, render(region.blocks), "Source presentation changed");
  if (region.blocks.length < 2) return undefined;
  const weights = region.blocks.map((b) => Buffer.byteLength(`${b.id}| ${b.text}\n`));
  const target = weights.reduce((a, b) => a + b, 0) / 2;
  let cut = 1,
    sum = 0,
    distance = Infinity;
  for (let i = 1; i < weights.length; i++) {
    sum += weights[i - 1];
    if (Math.abs(sum - target) < distance) {
      cut = i;
      distance = Math.abs(sum - target);
    }
  }
  const children = [region.blocks.slice(0, cut), region.blocks.slice(cut)].map((blocks) => ({
    start_line: blocks[0].start_line,
    end_line: blocks.at(-1)!.end_line,
    blocks,
    state: render(blocks),
  })) as [Region, Region];
  assert.equal(children[0].state + "\n" + children[1].state, region.state);
  return children;
}

function isTokenOverflow(status: number, body: string) {
  if (status !== 400) return false;
  try {
    return JSON.parse(body)?.detail?.error_type === "max_tokens_exceeded";
  } catch {
    return false;
  }
}

export function createRegionJudge<T = ReturnType<typeof validateAnswers>>(
  options: TokenRecoveryOptions & { policy?: RegionJudgePolicy<T> } = {},
) {
  const buildRequest = options.policy?.makeRequest ?? makeRequest;
  const parseAnswers =
    options.policy?.validateAnswers ??
    (validateAnswers as unknown as RegionJudgePolicy<T>["validateAnswers"]);
  const env = options.env ?? process.env,
    send = options.fetchImpl ?? fetch;
  const observe = options.observe ?? (() => {});
  const remaining = options.remainingTimeMs ?? (() => Infinity);
  const timeoutMs = options.timeoutMs ?? FIND_LIMITS.timeoutMs,
    reserveMs = options.reserveMs ?? 1000;
  // At most 31 network attempts per original region, even if every child overflows.
  const maxDepth = options.maxSplitDepth ?? 4;
  assert.ok(Number.isInteger(maxDepth) && maxDepth >= 0 && maxDepth <= 8);
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0 && Number.isFinite(reserveMs) && reserveMs >= 0,
  );
  const judgments = new Map<string, T>();
  const splits = new Map<string, [Region, Region]>();
  const safe = (value: unknown) =>
    env.TYPESAFE_API_KEY
      ? String(value).split(env.TYPESAFE_API_KEY).join("<redacted>")
      : String(value);

  const judge = async (
    docid: string,
    root: Region,
    queries: string[],
    batch: number,
    signal?: AbortSignal,
  ): Promise<RegionOutcome<T>[]> => {
    const walk = async (
      region: Region,
      depth: number,
      parent?: string,
    ): Promise<RegionOutcome<T>[]> => {
      signal?.throwIfAborted();
      const request = buildRequest(docid, region, queries, env.JEV_MODEL ?? "jev-1.13.0");
      const payload = JSON.stringify(request),
        hash = sha(payload);
      const cached = judgments.get(hash);
      if (cached) {
        observe({
          type: "judge_cache",
          batch,
          docid,
          request_sha256: hash,
          parent_request_sha256: parent,
        });
        return [{ region, ok: true, results: cached }];
      }
      let children = splits.get(hash);
      let failure = "http_400",
        overflow = Boolean(children);
      if (!children) {
        const left = depth > 0 ? remaining() : Infinity;
        if (Number.isNaN(left) || left <= reserveMs) {
          observe({
            type: "judge_recovery_skipped",
            batch,
            docid,
            request_sha256: hash,
            parent_request_sha256: parent,
            error: "token_recovery_budget_exhausted",
          });
          return [{ region, ok: false, error: "token_recovery_budget_exhausted" }];
        }
        const waitMs = Math.min(timeoutMs, Number.isFinite(left) ? left - reserveMs : timeoutMs);
        const start = performance.now();
        const record: Record<string, any> = {
          type: "judge",
          batch,
          docid,
          request,
          request_sha256: hash,
          parent_request_sha256: parent,
          split_depth: depth,
          attempt: 1,
          started_at: new Date().toISOString(),
          started_perf_ms: start,
          request_bytes: Buffer.byteLength(payload),
          timeout_ms: waitMs,
          phase: "awaiting_headers",
          ok: false,
        };
        try {
          assert.ok(env.TYPESAFE_API_KEY, "missing_key");
          const timeout = AbortSignal.timeout(Math.max(1, Math.floor(waitMs)));
          const response = await send(env.JEV_URL ?? "https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
            },
            body: payload,
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          record.http_status = response.status;
          record.headers_ms = performance.now() - start;
          record.provider_request_id =
            response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
          record.phase = "response_body";
          if (!response.ok) {
            const body = await response.text();
            overflow = isTokenOverflow(response.status, body);
            record.error_body = safe(body).slice(0, 8000);
            record.error_kind = overflow ? "max_tokens_exceeded" : "http_error";
            throw new Error(`http_${response.status}`);
          }
          const body = (await response.json()) as FindResponse;
          record.response = body;
          record.body_ms = performance.now() - start;
          record.phase = "decode";
          const results = parseAnswers(body, region, queries);
          judgments.set(hash, results);
          record.ok = true;
          record.phase = "complete";
          return [{ region, ok: true, results }];
        } catch (error) {
          const e = error as Error & {
            code?: string;
            cause?: { name?: string; code?: string; message?: string };
          };
          failure = safe(e.message ?? error);
          record.error = failure;
          record.error_name = e.name;
          if (e.cause)
            record.error_cause = {
              name: e.cause.name,
              code: e.cause.code,
              message: safe(e.cause.message),
            };
          record.error_code = e.code;
          record.error_kind ??= signal?.aborted
            ? "cancelled"
            : e.name === "TimeoutError"
              ? "timeout"
              : record.phase === "decode"
                ? "invalid_judgment"
                : "request_error";
          if (signal?.aborted) throw signal.reason ?? error;
        } finally {
          record.ended_perf_ms = performance.now();
          record.elapsed_ms = record.ended_perf_ms - start;
          observe(record);
        }
      }
      if (!overflow) return [{ region, ok: false, error: failure }];
      if (depth >= maxDepth) {
        observe({
          type: "judge_recovery_skipped",
          batch,
          docid,
          request_sha256: hash,
          error: "token_recovery_depth_limit",
        });
        return [{ region, ok: false, error: "max_tokens_exceeded: token_recovery_depth_limit" }];
      }
      const reused = Boolean(children);
      children ??= bisectRegion(region);
      if (!children) {
        observe({
          type: "judge_recovery_skipped",
          batch,
          docid,
          request_sha256: hash,
          error: "token_recovery_unsplittable_block",
        });
        return [
          { region, ok: false, error: "max_tokens_exceeded: token_recovery_unsplittable_block" },
        ];
      }
      splits.set(hash, children);
      observe({
        type: "judge_region_split",
        batch,
        docid,
        parent_request_sha256: hash,
        depth,
        reused,
        max_depth: maxDepth,
        original_blocks: region.blocks.length,
        children: children.map((child) => ({
          start_line: child.start_line,
          end_line: child.end_line,
          block_ids: child.blocks.map((b) => b.id),
          state_sha256: sha(child.state),
          request_sha256: sha(
            JSON.stringify(buildRequest(docid, child, queries, env.JEV_MODEL ?? "jev-1.13.0")),
          ),
        })),
      });
      // Keep the same worker slot. Child requests must not multiply scan concurrency.
      const results: RegionOutcome<T>[] = [];
      for (const child of children) results.push(...(await walk(child, depth + 1, hash)));
      return results;
    };
    return walk(root, 0);
  };
  judge.reset = () => {
    judgments.clear();
    splits.clear();
  };
  return judge;
}
