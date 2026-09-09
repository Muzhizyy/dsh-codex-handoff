/** Shared, browser-safe safety limits. Values are intentionally finite. */
export const HARD_LIMITS = Object.freeze({
  discoverPageResults: 200,
  filesScanned: 20_000,
  lineBytes: 8 * 1024 * 1024,
  sourceFileBytes: 1024 * 1024 * 1024,
  chainDecompressedBytes: 512 * 1024 * 1024,
  chainDepth: 32,
  chainFiles: 64,
  records: 1_000_000,
  normalizedTextBytes: 1024 * 1024,
  normalizedToolResultBytes: 1024 * 1024,
  previewSnippetBytes: 8 * 1024,
  diagnosticMessageChars: 8 * 1024,
  diagnostics: 10_000,
  provenanceRecords: 50_000,
  manifestItems: 10_000,
  aggregateManifestTextBytes: 16 * 1024 * 1024,
  aggregateAnalysisTextBytes: 16 * 1024 * 1024,
  remoteListSearchChars: 512,
  remoteDetailsChars: 8 * 1024,
  seedEvents: 1_000_000,
  seedEventBytes: 64 * 1024 * 1024,
  /** Durable restart artifacts stay well below the whole-ledger byte cap. */
  recoveryArtifactBytes: 1 * 1024 * 1024,
  evidenceItems: 20_000,
  analysisClaims: 10_000,
  contextTokens: 16_000,
  estimatedTokens: 1_000_000,
})

export const DEFAULT_LIMITS = Object.freeze({
  discoverPageResults: 50,
  filesScanned: 5_000,
  lineBytes: 2 * 1024 * 1024,
  sourceFileBytes: 256 * 1024 * 1024,
  chainDecompressedBytes: 256 * 1024 * 1024,
  chainDepth: 16,
  chainFiles: 32,
  records: 250_000,
  normalizedTextBytes: 256 * 1024,
  normalizedToolResultBytes: 128 * 1024,
  previewSnippetBytes: 2 * 1024,
})

export const BUDGET_LIMITS = Object.freeze({
  minimumTargetTokens: 2_000,
  defaultTargetTokens: 6_000,
  recommendedWarningTokens: 32_000,
  hardTrajectoryTokens: 128_000,
  recommendedWarningBytes: 16 * 1024 * 1024,
  hardTrajectoryBytes: 64 * 1024 * 1024,
  reservedMinimumTokens: 400,
  reservedFraction: 0.1,
})

export const DEFAULT_PARSER_LIMITS = Object.freeze({
  ...DEFAULT_LIMITS,
})

export const DEFAULT_PARSE_LIMITS = DEFAULT_PARSER_LIMITS

export type LimitName = keyof typeof DEFAULT_LIMITS

/** Count bytes as UTF-8 without relying on Node's Buffer API. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0
    if (codePoint <= 0x7f) bytes += 1
    else if (codePoint <= 0x7ff) bytes += 2
    else if (codePoint <= 0xffff) bytes += 3
    else {
      bytes += 4
      index += 1
    }
  }
  return bytes
}

export function boundedInteger(value: number, name: keyof typeof HARD_LIMITS): number {
  const maximum = HARD_LIMITS[name]
  if (!Number.isSafeInteger(value) || value < 0) {
    const defaults = DEFAULT_LIMITS as Partial<Record<keyof typeof HARD_LIMITS, number>>
    return defaults[name] ?? maximum
  }
  return Math.min(value, maximum)
}
