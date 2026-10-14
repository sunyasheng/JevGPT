/** The explicit-target entry preserves v5; ranked discovery starts with one full batch. */
export function batchingPolicy(primaryCount?: number) {
  return {
    initial: Math.max(1, primaryCount ?? 10),
    step: 10,
    minimumDiscoveryDocuments: primaryCount === undefined ? 10 : 11,
  };
}
