/** Optional static host mapping for the Jev API, e.g. JEV_HOST_OVERRIDE="api.typesafe.ai=127.0.0.1".
 * Used with an SSH tunnel when the direct network path to the API edge drops connections. Only name
 * resolution changes: the URL host, TLS server name and certificate validation stay the real host, so
 * the request is still end-to-end TLS to the API. Research logic is untouched. */
import dns from "node:dns";

export function parseHostOverride(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const [host, address] = pair.split("=").map((s) => s.trim());
    if (host && address) map.set(host.toLowerCase(), address);
  }
  return map;
}

let installed = false;
export function installHostOverride(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const map = parseHostOverride(env.JEV_HOST_OVERRIDE);
  if (!map.size || installed) return map;
  installed = true;
  const original = dns.lookup;
  const patched = function (this: unknown, hostname: string, options: unknown, callback?: unknown) {
    let opts = options as { all?: boolean; family?: number } | number | undefined;
    let cb = callback as ((...a: unknown[]) => void) | undefined;
    if (typeof options === "function") {
      cb = options as (...a: unknown[]) => void;
      opts = undefined;
    }
    const address = map.get(String(hostname).toLowerCase());
    if (address && cb) {
      const family = address.includes(":") ? 6 : 4;
      const all = typeof opts === "object" && opts !== null && Boolean(opts.all);
      const done = cb;
      process.nextTick(() =>
        all ? done(null, [{ address, family }]) : done(null, address, family),
      );
      return;
    }
    return (original as (...a: unknown[]) => unknown).call(this, hostname, options, callback);
  };
  (dns as unknown as { lookup: unknown }).lookup = patched;
  return map;
}
