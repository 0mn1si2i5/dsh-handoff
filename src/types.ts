export interface HandoffConfig {
  summarizationProvider?: string
  summarizationModel?: string
  maxTokens?: number
  maxDocumentBytes?: number
  gitTimeoutMs?: number
}

export interface ResolvedHandoffConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
  readonly maxDocumentBytes: number
  readonly gitTimeoutMs: number
}
