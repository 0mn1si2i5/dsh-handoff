import type { HandoffDocumentInput, ParsedHandoffDocument, SummarySections } from './types.ts';
export declare function handoffDigest(text: string): string;
export declare function renderHandoffDocument(input: HandoffDocumentInput): string;
export declare function parseSummaryMarkdown(text: string): SummarySections;
export declare function parseHandoffDocument(text: string, maxBytes: number): ParsedHandoffDocument;
