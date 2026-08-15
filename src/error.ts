export type HandoffErrorCode = 'busy' | 'cancelled' | 'git' | 'model' | 'document' | 'filesystem'

export class HandoffError extends Error {
  constructor(
    readonly code: HandoffErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'HandoffError'
  }
}
