export type HandoffErrorCode = 'busy' | 'cancelled' | 'git' | 'model' | 'document' | 'filesystem';
export declare class HandoffError extends Error {
    readonly code: HandoffErrorCode;
    constructor(code: HandoffErrorCode, message: string, options?: ErrorOptions);
}
