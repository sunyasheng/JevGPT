/** Record model/effort and a request hash without logging credentials or changing requests. */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const auditPath = process.env.PI_NEUCLIR_TRANSPORT_AUDIT;
if (auditPath) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (new URL(url).pathname.endsWith("/responses")) {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : null);
      if (typeof body === "string") {
        const payload = JSON.parse(body);
        appendFileSync(auditPath, JSON.stringify({
          at: new Date().toISOString(), request_sha256: createHash("sha256").update(body).digest("hex"),
          model: payload.model, reasoning_effort: payload.reasoning?.effort, stream: payload.stream,
        }) + "\n");
      }
    }
    return originalFetch.call(this, input, init);
  };
}
