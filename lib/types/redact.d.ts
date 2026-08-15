import type { Message } from '@deepseek-ai/dsh-llm';
import type { RedactionCounts } from './types.ts';
export interface RedactionResult<T> {
    readonly value: T;
    readonly counts: Readonly<RedactionCounts>;
}
export declare function redactText(text: string, env: NodeJS.ProcessEnv): {
    text: string;
    counts: Readonly<RedactionCounts>;
};
export declare function redactMessages(messages: readonly Message[], env: NodeJS.ProcessEnv): RedactionResult<Message[]>;
export declare function mergeRedactionCounts(...counts: readonly RedactionCounts[]): Readonly<RedactionCounts>;
