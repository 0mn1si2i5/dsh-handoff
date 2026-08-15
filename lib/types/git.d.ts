import type { SubprocessService } from '@deepseek-ai/dsh-subprocess';
import type { GitSnapshot } from './types.ts';
export declare function parsePorcelainZ(text: string): string[];
export declare function captureGit(subprocess: SubprocessService, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<GitSnapshot>;
