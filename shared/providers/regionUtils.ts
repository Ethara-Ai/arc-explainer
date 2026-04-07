/**
 * Extract the region from a cloud resource ID string.
 */
export function extractRegionFromId(modelId: string): string | null {
  if (!modelId.startsWith("arn:")) return null;
  const parts = modelId.split(":");
  return parts.length >= 4 ? parts[3] : null;
}

