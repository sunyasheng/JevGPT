import { randomUUID } from "node:crypto";
import { Type } from "typebox";

export const POOL_RULE = "Every search also adds its top 1,000 documents to a question pool. Use pool_grep to check whether a candidate name co-occurs with a distinctive clue anywhere in the full text of pooled documents, including documents that jev_find has not scanned. It is cheap. Use it to confirm or reject a hypothesis, then send promising docids to jev_find or read_document.";
export const PoolGrepSchema = Type.Object({
  reason: Type.String({ minLength: 1 }),
  all_of: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 4 }),
  show: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  near: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  window: Type.Optional(Type.Integer({ minimum: 0, maximum: 300 })),
  max_docs: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});
export class DeepPool {
  private id = randomUUID();
  private size = 0;
  constructor(private audit: (record: object) => void) {}
  reset() { this.id = randomUUID(); this.size = 0; }
  private async call(operation: string, body: object, signal?: AbortSignal): Promise<any> {
    const response = await fetch(`${process.env.CMASS_POOL_URL ?? "http://127.0.0.1:29782"}/${operation}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, pool_id: this.id }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `pool ${operation} failed`);
    return result;
  }
  async add(query: string, search_id: string, signal?: AbortSignal) {
    const result = await this.call("add", {query, search_id}, signal);
    this.size = result.pool_size;
    this.audit({type: "deep_pool_add", query, search_id, ...result});
  }
  async grep(params: object, signal?: AbortSignal) {
    const result = await this.call("grep", params, signal);
    this.audit({type: "pool_grep", ...result});
    return { content: [{type: "text" as const, text: result.text}], details: result };
  }
  finish() {
    this.audit({type: "deep_pool_summary", pool_size: this.size, pool_id: this.id});
  }
}
