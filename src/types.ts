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

export type SecretKind = 'api-token' | 'authorization' | 'private-key' | 'npm-token' | 'password' | 'environment'
export type RedactionCounts = Partial<Record<SecretKind, number>>

export interface SummarySections {
  readonly objective: string
  readonly userRequirementsAndDecisions: string
  readonly completedWork: string
  readonly currentState: string
  readonly validation: string
  readonly failedAttemptsAndWarnings: string
  readonly remainingWork: string
  readonly recommendedNextAction: string
  readonly criticalReferences: string
}

export interface HandoffMetadata {
  readonly generated: string
  readonly sourceSession: string
  readonly capturedThroughSeq: number | null
  readonly workspace: string
  readonly gitBranch: string
  readonly gitHead: string
  readonly gitStateDigest: string
}

export interface HandoffDocumentInput {
  readonly metadata: HandoffMetadata
  readonly summary: SummarySections
  readonly changedFiles: readonly string[]
  readonly redactions: Readonly<RedactionCounts>
}

export interface ParsedHandoffDocument extends HandoffDocumentInput {
  readonly format: 'dsh-handoff/v1'
  readonly text: string
  readonly digest: string
}
