import z from "@deepseek-ai/schemastery";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { FsError } from "@deepseek-ai/dsh-fs";
//#region src/config.ts
const ALLOWED_KEYS = /* @__PURE__ */ new Set([
	"summarizationProvider",
	"summarizationModel",
	"maxTokens",
	"maxDocumentBytes",
	"gitTimeoutMs"
]);
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_DOCUMENT_BYTES = 32768;
const DEFAULT_GIT_TIMEOUT_MS = 1e4;
const Config = z.object({
	summarizationProvider: z.string(),
	summarizationModel: z.string(),
	maxTokens: z.number(),
	maxDocumentBytes: z.number(),
	gitTimeoutMs: z.number()
});
function assertPositiveSafeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}
function resolveConfig(config) {
	for (const key of Object.keys(config)) if (!ALLOWED_KEYS.has(key)) throw new Error(`unknown configuration key: ${key}`);
	const provider = config.summarizationProvider;
	const model = config.summarizationModel;
	if (provider === void 0 && model !== void 0) throw new Error("summarizationProvider and summarizationModel must be configured together");
	if (provider !== void 0 && model === void 0) throw new Error("summarizationProvider and summarizationModel must be configured together");
	if (provider !== void 0 && provider.length === 0) throw new Error("summarizationProvider must be a non-empty string");
	if (model !== void 0 && model.length === 0) throw new Error("summarizationModel must be a non-empty string");
	const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
	const maxDocumentBytes = config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
	const gitTimeoutMs = config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
	assertPositiveSafeInteger(maxTokens, "maxTokens");
	assertPositiveSafeInteger(maxDocumentBytes, "maxDocumentBytes");
	assertPositiveSafeInteger(gitTimeoutMs, "gitTimeoutMs");
	return {
		summarizationProvider: provider ?? "",
		summarizationModel: model ?? "",
		maxTokens,
		maxDocumentBytes,
		gitTimeoutMs
	};
}
//#endregion
//#region src/error.ts
var HandoffError = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.code = code;
		this.name = "HandoffError";
	}
};
//#endregion
//#region src/git.ts
const MAX_GIT_STDOUT_BYTES = 256 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const GIT_TERMINATION_GRACE_MS = 1e3;
const HANDOFF_PATH$1 = "docs/handoffs/current.md";
const ARGV_ROOT = ["rev-parse", "--show-toplevel"];
const ARGV_HEAD = ["rev-parse", "HEAD"];
const ARGV_BRANCH = ["branch", "--show-current"];
const ARGV_STATUS = [
	"status",
	"--porcelain=v1",
	"-z",
	"--untracked-files=all",
	"--",
	".",
	":(exclude)docs/handoffs/current.md"
];
const GIT_TIMEOUT_MESSAGE = "git command timed out";
function readCollected(reader) {
	if (reader === void 0) return {
		text: "",
		lossy: false
	};
	const read = reader.readFrom(0);
	return {
		text: read.text,
		lossy: read.lossy
	};
}
/** Preserve caller cancellation, then classify a fired timeout separately. */
function rethrowAbort(signal, timeout) {
	if (signal?.aborted) signal.throwIfAborted();
	if (timeout.aborted) throw new Error(GIT_TIMEOUT_MESSAGE);
}
async function runGit(subprocess, cwd, argv, signal, timeoutMs) {
	if (signal?.aborted) signal.throwIfAborted();
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(/* @__PURE__ */ new Error(GIT_TIMEOUT_MESSAGE)), timeoutMs);
	timer.unref();
	const combined = signal === void 0 ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
	try {
		let executable;
		try {
			executable = await subprocess.resolveExecutable("git", void 0, combined);
		} catch (error) {
			rethrowAbort(signal, timeout.signal);
			throw new Error("git failed to start", { cause: error });
		}
		rethrowAbort(signal, timeout.signal);
		let handle;
		try {
			const spec = {
				argv: [executable, ...argv],
				cwd,
				stdio: {
					stdin: "ignore",
					stdout: { maxBytes: MAX_GIT_STDOUT_BYTES },
					stderr: { maxBytes: MAX_GIT_STDERR_BYTES }
				},
				graceMs: GIT_TERMINATION_GRACE_MS,
				signal: combined
			};
			handle = subprocess.spawn(spec);
		} catch (error) {
			rethrowAbort(signal, timeout.signal);
			throw new Error("git failed to start", { cause: error });
		}
		let outcome;
		try {
			outcome = await handle.done;
		} catch (error) {
			rethrowAbort(signal, timeout.signal);
			throw new Error("git failed to start", { cause: error });
		}
		rethrowAbort(signal, timeout.signal);
		if (outcome.exitCode !== 0) throw new Error("git command failed");
		const stdout = readCollected(handle.collected.stdout);
		const stderr = readCollected(handle.collected.stderr);
		if (stdout.lossy || stderr.lossy) throw new Error("git output exceeded the collection limit");
		return stdout.text;
	} finally {
		clearTimeout(timer);
	}
}
function parsePorcelainZ(text) {
	if (text === "") return [];
	const records = text.split("\0");
	const result = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record === "") {
			if (index === records.length - 1) continue;
			throw new Error("malformed git porcelain record: empty record");
		}
		if (record.length < 4) throw new Error("malformed git porcelain record: short record");
		const x = record[0];
		const y = record[1];
		const path = record.slice(3);
		if (x === "R" || x === "C" || y === "R" || y === "C") {
			const source = records[index + 1];
			if (source === void 0 || source === "") throw new Error("malformed git porcelain record: rename or copy without source");
			index += 1;
			if (path !== HANDOFF_PATH$1) result.push(`${record} <- ${source}`);
			continue;
		}
		if (path !== HANDOFF_PATH$1) result.push(record);
	}
	return result;
}
function normalizeRelative(root, cwd) {
	const rel = relative(root, cwd).replace(/\\/g, "/");
	return rel === "" ? "." : rel;
}
function stateDigest(branch, head, changedFiles) {
	return createHash("sha256").update(JSON.stringify([
		branch,
		head,
		changedFiles
	])).digest("hex");
}
async function captureGit(subprocess, cwd, signal, timeoutMs) {
	signal?.throwIfAborted();
	const root = (await runGit(subprocess, cwd, ARGV_ROOT, signal, timeoutMs)).trim();
	const head = (await runGit(subprocess, root, ARGV_HEAD, signal, timeoutMs)).trim();
	const branch = (await runGit(subprocess, root, ARGV_BRANCH, signal, timeoutMs)).trim();
	const changedFiles = parsePorcelainZ(await runGit(subprocess, root, ARGV_STATUS, signal, timeoutMs));
	return {
		root,
		relativeCwd: normalizeRelative(root, cwd),
		branch,
		head,
		changedFiles,
		stateDigest: stateDigest(branch, head, changedFiles)
	};
}
//#endregion
//#region src/document.ts
const FORMAT = "dsh-handoff/v1";
const MODEL_HEADINGS = [
	"Objective",
	"User Requirements and Decisions",
	"Completed Work",
	"Current State",
	"Validation",
	"Failed Attempts and Warnings",
	"Remaining Work",
	"Recommended Next Action",
	"Critical References"
];
const FINAL_HEADINGS = [
	"Objective",
	"User Requirements and Decisions",
	"Completed Work",
	"Current State",
	"Changed Files",
	"Validation",
	"Failed Attempts and Warnings",
	"Remaining Work",
	"Recommended Next Action",
	"Critical References",
	"Redaction Warnings"
];
const SUMMARY_FIELDS = {
	Objective: "objective",
	"User Requirements and Decisions": "userRequirementsAndDecisions",
	"Completed Work": "completedWork",
	"Current State": "currentState",
	Validation: "validation",
	"Failed Attempts and Warnings": "failedAttemptsAndWarnings",
	"Remaining Work": "remainingWork",
	"Recommended Next Action": "recommendedNextAction",
	"Critical References": "criticalReferences"
};
function handoffDigest(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
function formatCapturedThroughSeq(value) {
	return value === null ? "null" : String(value);
}
function renderRedactionWarnings(redactions) {
	const categories = Object.keys(redactions).sort();
	if (categories.length === 0) return "(none)";
	return categories.flatMap((category) => {
		const count = redactions[category];
		return count === void 0 ? [] : [`${category}: ${count}`];
	}).join("\n");
}
function renderSection(heading, input) {
	if (heading === "Changed Files") return input.changedFiles.length === 0 ? "(none)" : input.changedFiles.join("\n");
	if (heading === "Redaction Warnings") return renderRedactionWarnings(input.redactions);
	const field = SUMMARY_FIELDS[heading];
	if (field === void 0) throw new Error(`unexpected section: ${heading}`);
	return input.summary[field];
}
function renderHandoffDocument(input) {
	const lines = [
		"# DSH Handoff",
		"",
		`Format: ${FORMAT}`,
		`Generated: ${input.metadata.generated}`,
		`Source session: ${input.metadata.sourceSession}`,
		`Captured through seq: ${formatCapturedThroughSeq(input.metadata.capturedThroughSeq)}`,
		`Workspace: ${input.metadata.workspace}`,
		`Git branch: ${input.metadata.gitBranch}`,
		`Git HEAD: ${input.metadata.gitHead}`,
		`Git state digest: ${input.metadata.gitStateDigest}`,
		""
	];
	for (const heading of FINAL_HEADINGS) {
		lines.push(`## ${heading}`);
		lines.push(renderSection(heading, input));
		lines.push("");
	}
	return lines.join("\n");
}
function readField(lines, index, label) {
	const line = lines[index];
	if (line === void 0) throw new Error(`missing metadata field: ${label}`);
	const prefix = `${label}: `;
	if (!line.startsWith(prefix)) throw new Error(`expected metadata field: ${label}`);
	return line.slice(prefix.length);
}
function parseCapturedThroughSeq(value) {
	if (value === "null") return null;
	if (!/^\d+$/.test(value)) throw new Error("Captured through seq must be null or a non-negative safe integer");
	const number = Number(value);
	if (!Number.isSafeInteger(number)) throw new Error("Captured through seq must be a non-negative safe integer");
	return number;
}
function parseGitHead(value) {
	if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Git HEAD must be a 40-character hexadecimal string");
	return value;
}
function parseGitStateDigest(value) {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Git state digest must be a 64-character hexadecimal string");
	return value;
}
function parseChangedFiles(body) {
	if (body === "(none)") return [];
	return body.split("\n");
}
const SECRET_KINDS = /* @__PURE__ */ new Set([
	"api-token",
	"authorization",
	"private-key",
	"npm-token",
	"password",
	"environment"
]);
function parseRedactionWarnings(body) {
	if (body === "(none)") return {};
	const counts = {};
	for (const line of body.split("\n")) {
		const separator = line.indexOf(": ");
		if (separator < 0) throw new Error("invalid redaction warning line");
		const category = line.slice(0, separator);
		const countText = line.slice(separator + 2);
		if (!SECRET_KINDS.has(category)) throw new Error("unknown redaction category");
		if (counts[category] !== void 0) throw new Error("duplicate redaction category");
		const count = Number(countText);
		if (!/^[1-9][0-9]*$/.test(countText) || !Number.isSafeInteger(count)) throw new Error("invalid redaction warning count");
		counts[category] = count;
	}
	return counts;
}
function collectBody(body) {
	let start = 0;
	let end = body.length;
	while (start < end && body[start] === "") start += 1;
	while (end > start && body[end - 1] === "") end -= 1;
	return body.slice(start, end).join("\n");
}
function parseSectionLines(lines, startIndex, headings) {
	const bodies = [];
	let headingIndex = 0;
	let body = null;
	for (let index = startIndex; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.startsWith("## ")) {
			const heading = line.slice(3).trim();
			if (headingIndex >= headings.length) throw new Error(`unexpected heading: ${heading}`);
			if (heading !== headings[headingIndex]) throw new Error(`unexpected heading: ${heading}`);
			if (body !== null) bodies.push(collectBody(body));
			body = [];
			headingIndex += 1;
		} else if (body === null) throw new Error("preamble is not allowed");
		else body.push(line);
	}
	if (body !== null) bodies.push(collectBody(body));
	if (headingIndex !== headings.length) throw new Error("missing section heading");
	for (let index = 0; index < bodies.length; index += 1) if (bodies[index].trim() === "") throw new Error(`empty section: ${headings[index]}`);
	return bodies;
}
function parseSummaryMarkdown(text) {
	const bodies = parseSectionLines(text.replace(/\r\n/g, "\n").split("\n"), 0, MODEL_HEADINGS);
	return {
		objective: bodies[0],
		userRequirementsAndDecisions: bodies[1],
		completedWork: bodies[2],
		currentState: bodies[3],
		validation: bodies[4],
		failedAttemptsAndWarnings: bodies[5],
		remainingWork: bodies[6],
		recommendedNextAction: bodies[7],
		criticalReferences: bodies[8]
	};
}
function parseHandoffDocument(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("document exceeds the UTF-8 byte limit");
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	let index = 0;
	if (lines[index] !== "# DSH Handoff") throw new Error("document must begin with the title");
	index += 1;
	if (lines[index] !== "") throw new Error("expected a blank line after the title");
	index += 1;
	const format = readField(lines, index, "Format");
	index += 1;
	const generated = readField(lines, index, "Generated");
	index += 1;
	const sourceSession = readField(lines, index, "Source session");
	index += 1;
	const capturedThroughSeqRaw = readField(lines, index, "Captured through seq");
	index += 1;
	const workspace = readField(lines, index, "Workspace");
	index += 1;
	const gitBranch = readField(lines, index, "Git branch");
	index += 1;
	const gitHead = readField(lines, index, "Git HEAD");
	index += 1;
	const gitStateDigest = readField(lines, index, "Git state digest");
	index += 1;
	if (format !== FORMAT) throw new Error(`unknown format: ${format}`);
	if (lines[index] !== "") throw new Error("expected a blank line after metadata");
	index += 1;
	const sections = parseSectionLines(lines, index, FINAL_HEADINGS);
	const metadata = {
		generated,
		sourceSession,
		capturedThroughSeq: parseCapturedThroughSeq(capturedThroughSeqRaw),
		workspace,
		gitBranch,
		gitHead: parseGitHead(gitHead),
		gitStateDigest: parseGitStateDigest(gitStateDigest)
	};
	const summary = {
		objective: sections[0],
		userRequirementsAndDecisions: sections[1],
		completedWork: sections[2],
		currentState: sections[3],
		validation: sections[5],
		failedAttemptsAndWarnings: sections[6],
		remainingWork: sections[7],
		recommendedNextAction: sections[8],
		criticalReferences: sections[9]
	};
	return {
		format: FORMAT,
		metadata,
		summary,
		changedFiles: parseChangedFiles(sections[4]),
		redactions: parseRedactionWarnings(sections[10]),
		text: normalized,
		digest: handoffDigest(normalized)
	};
}
//#endregion
//#region src/redact.ts
const MIN_CREDENTIAL_CHARS = 8;
const RULES = [
	{
		kind: "regex",
		category: "private-key",
		regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
		replacement: "<redacted:private-key>"
	},
	{
		kind: "assignment",
		category: "npm-token",
		name: /_authToken/,
		marker: "<redacted:npm-token>"
	},
	{
		kind: "regex",
		category: "npm-token",
		regex: /npm_[^\s,;]{8,}/g,
		replacement: "<redacted:npm-token>"
	},
	{
		kind: "regex",
		category: "authorization",
		regex: /(Bearer|Basic)\s+[^\s,;]{8,}/gi,
		replacement: "$1 <redacted:authorization>"
	},
	{
		kind: "regex",
		category: "password",
		regex: /(:\/\/[^/\s:@]+:)([^@\s]{8,})(@)/g,
		replacement: "$1<redacted:password>$3"
	},
	{
		kind: "regex",
		category: "api-token",
		regex: /(sk_|dsk_|ghp_|github_pat_)[^\s,;]{8,}/g,
		replacement: "<redacted:api-token>"
	},
	{
		kind: "assignment",
		category: "password",
		name: /password/i,
		marker: "<redacted:password>"
	},
	{
		kind: "assignment",
		category: "api-token",
		name: /\b(?:api[_-]?key|token|secret)\b/i,
		marker: "<redacted:api-token>"
	}
];
const VALUE_SEPARATOR = /[\s,;]/;
function isValueSeparator(char) {
	return VALUE_SEPARATOR.test(char);
}
function isHorizontalWhitespace(char) {
	return char === " " || char === "	";
}
function scanUnquoted(text, start) {
	let index = start;
	while (index < text.length && !isValueSeparator(text[index])) index += 1;
	return {
		length: index - start,
		contentLength: index - start
	};
}
function scanAdjacentSuffix(text, start) {
	const first = text[start];
	if (first === void 0 || isValueSeparator(first)) return {
		length: 0,
		contentLength: 0
	};
	return scanUnquoted(text, start);
}
function scanValueSpan(text, start) {
	const first = text[start];
	if (first !== "\"" && first !== "'") return scanUnquoted(text, start);
	const quote = first;
	let index = start + 1;
	let contentLength = 0;
	let closed = false;
	while (index < text.length) {
		const char = text[index];
		if (char === "\n" || char === "\r") break;
		if (char === "\\") {
			const next = text[index + 1];
			if (next !== void 0 && next !== "\n" && next !== "\r") {
				contentLength += 1;
				index += 2;
			} else {
				contentLength += 1;
				index += 1;
			}
			continue;
		}
		if (char === quote) {
			closed = true;
			index += 1;
			break;
		}
		contentLength += 1;
		index += 1;
	}
	if (!closed) return {
		length: index - start,
		contentLength
	};
	const suffix = scanAdjacentSuffix(text, index);
	return {
		length: index - start + suffix.length,
		contentLength: contentLength + suffix.contentLength
	};
}
function matchAssignmentSeparator(text, nameEnd) {
	let index = nameEnd;
	while (index < text.length && isHorizontalWhitespace(text[index])) index += 1;
	if (index >= text.length) return null;
	const char = text[index];
	if (char !== "=" && char !== ":") return null;
	index += 1;
	while (index < text.length && isHorizontalWhitespace(text[index])) index += 1;
	return {
		text: text.slice(nameEnd, index),
		end: index
	};
}
function redactAssignments(text, name, marker) {
	const flags = name.global ? name.flags : `${name.flags}g`;
	const pattern = new RegExp(name.source, flags);
	let output = "";
	let copied = 0;
	let count = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index;
		if (index < copied) continue;
		const nameEnd = index + match[0].length;
		const separator = matchAssignmentSeparator(text, nameEnd);
		if (separator === null) continue;
		const span = scanValueSpan(text, separator.end);
		if (span.contentLength < MIN_CREDENTIAL_CHARS) continue;
		output += text.slice(copied, nameEnd) + separator.text + marker;
		copied = separator.end + span.length;
		count += 1;
	}
	output += text.slice(copied);
	return {
		text: output,
		count
	};
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isSensitiveEnvName(name) {
	return /(?:key|token|secret|password)/i.test(name);
}
function applyRule(text, rule) {
	if (rule.kind === "regex") {
		const matches = text.match(rule.regex);
		const count = matches === null ? 0 : matches.length;
		return {
			text: text.replace(rule.regex, rule.replacement),
			count
		};
	}
	return redactAssignments(text, rule.name, rule.marker);
}
function addCount(target, category, count) {
	if (count === 0) return;
	target[category] = (target[category] ?? 0) + count;
}
function compareByLengthThenValue(a, b) {
	if (a.length !== b.length) return b.length - a.length;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
function redactEnvironment(text, env) {
	const values = /* @__PURE__ */ new Set();
	for (const [name, value] of Object.entries(env)) {
		if (value === void 0 || value.length < MIN_CREDENTIAL_CHARS) continue;
		if (!isSensitiveEnvName(name)) continue;
		values.add(value);
	}
	let output = text;
	let count = 0;
	for (const value of [...values].sort(compareByLengthThenValue)) {
		const pattern = new RegExp(escapeRegExp(value), "g");
		const matches = output.match(pattern);
		if (matches === null) continue;
		output = output.replace(pattern, "<redacted:environment>");
		count += matches.length;
	}
	return {
		text: output,
		count
	};
}
function redactText(text, env) {
	const counts = {};
	let output = text;
	for (const rule of RULES) {
		const result = applyRule(output, rule);
		output = result.text;
		addCount(counts, rule.category, result.count);
	}
	const environment = redactEnvironment(output, env);
	addCount(counts, "environment", environment.count);
	return {
		text: environment.text,
		counts
	};
}
function redactInPlace(value, env, counts) {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const item = value[index];
			if (typeof item === "string") {
				const result = redactText(item, env);
				value[index] = result.text;
				for (const [category, count] of Object.entries(result.counts)) if (count !== void 0) addCount(counts, category, count);
			} else redactInPlace(item, env, counts);
		}
		return;
	}
	if (typeof value === "object" && value !== null) {
		const record = value;
		for (const key of Object.keys(record)) {
			const item = record[key];
			if (typeof item === "string") {
				const result = redactText(item, env);
				record[key] = result.text;
				for (const [category, count] of Object.entries(result.counts)) if (count !== void 0) addCount(counts, category, count);
			} else redactInPlace(item, env, counts);
		}
	}
}
function redactMessages(messages, env) {
	const value = structuredClone(messages);
	const counts = {};
	redactInPlace(value, env, counts);
	return {
		value,
		counts
	};
}
function mergeRedactionCounts(...counts) {
	const merged = {};
	for (const source of counts) for (const [category, count] of Object.entries(source)) if (count !== void 0) addCount(merged, category, count);
	return merged;
}
//#endregion
//#region src/summarize.ts
const SUMMARY_INSTRUCTION = `You are producing a compact engineering handoff for a fresh DeepSeek Harness session. Summarize only the conversation above. Preserve user decisions, exact paths, commands, errors, validation results, unfinished work, and one concrete next action.

Output exactly these headings in order. Use terse bullets. Write \`(none)\` for an empty section. Output no preamble and call no tools.

## Objective
## User Requirements and Decisions
## Completed Work
## Current State
## Validation
## Failed Attempts and Warnings
## Remaining Work
## Recommended Next Action
## Critical References`;
function resolveRoute(agent, config) {
	if (config.summarizationProvider !== "" && config.summarizationModel !== "") return {
		provider: config.summarizationProvider,
		model: config.summarizationModel
	};
	const header = agent.session.requestHeader()?.config;
	if (header !== void 0 && header.provider !== "" && header.model !== "") return {
		provider: header.provider,
		model: header.model
	};
	const options = agent.options;
	if (options.provider !== void 0 && options.provider !== "" && options.model !== void 0 && options.model !== "") return {
		provider: options.provider,
		model: options.model
	};
	throw new Error("no complete provider/model route for summarization");
}
async function summarizeHandoff(stream, request) {
	request.signal?.throwIfAborted();
	const route = resolveRoute(request.agent, request.config);
	const redacted = redactMessages(request.messages, request.env);
	const instruction = createUserMessage({
		content: [{
			type: "text",
			text: SUMMARY_INSTRUCTION
		}],
		source: {
			kind: "plugin",
			plugin: "dsh-handoff"
		}
	});
	const options = {
		provider: route.provider,
		model: route.model,
		messages: [...redacted.value, instruction],
		maxTokens: request.config.maxTokens,
		sessionId: request.agent.session.id,
		...request.signal === void 0 ? {} : { signal: request.signal }
	};
	const assembler = new BlockAssembler();
	let sawFinish = false;
	for await (const chunk of stream(options)) {
		if (chunk.type === "finish") sawFinish = true;
		assembler.push(chunk);
	}
	if (!sawFinish) throw new Error("summary stream ended without a finish");
	if (assembler.finish.kind !== "stop") throw new Error("summary stream did not finish successfully");
	const parts = [];
	for (const block of assembler.blocks()) if (block.type === "text") {
		if (block.text.trim() !== "") parts.push(block.text);
	} else if (block.type === "reasoning") {} else throw new Error("summary produced a non-text block");
	const text = parts.join("\n");
	if (text.trim() === "") throw new Error("summary produced no text");
	const output = redactText(text, request.env);
	return {
		summary: parseSummaryMarkdown(output.text),
		redactions: { ...mergeRedactionCounts({ ...redacted.counts }, { ...output.counts }) }
	};
}
//#endregion
//#region src/storage.ts
const HANDOFF_PATH = "docs/handoffs/current.md";
function classifyFsError(error, message) {
	if (error instanceof FsError) {
		if (error.code === "FS_ABORTED") return new HandoffError("cancelled", "filesystem operation was cancelled");
		return new HandoffError("filesystem", message, { cause: error });
	}
	throw error;
}
async function fsCall(operation, message) {
	try {
		return await operation();
	} catch (error) {
		throw classifyFsError(error, message);
	}
}
async function resolveHandoffTarget(fs, root, signal) {
	const linkInfo = await fsCall(() => fs.lstat(HANDOFF_PATH, { cwd: root }, signal), "handoff path is not accessible");
	if (linkInfo !== void 0 && linkInfo.type === "symlink") throw new HandoffError("filesystem", "handoff path must not be a symbolic link");
	const rootTarget = await fsCall(() => fs.resolve(root, { signal }), "handoff path is not accessible");
	const target = await fsCall(() => fs.resolve(HANDOFF_PATH, {
		cwd: root,
		signal
	}), "handoff path is not accessible");
	if (!fs.contains(rootTarget, target)) throw new HandoffError("filesystem", "handoff path must stay inside the repository");
	const info = await fsCall(() => fs.stat(target, signal), "handoff path is not accessible");
	if (info !== void 0 && info.type !== "file") throw new HandoffError("filesystem", "handoff path must be a regular file");
	return target;
}
async function readHandoffText(fs, root, maxBytes, signal) {
	const target = await resolveHandoffTarget(fs, root, signal);
	const info = await fsCall(() => fs.stat(target, signal), "handoff document is not accessible");
	if (info === void 0) throw new HandoffError("filesystem", "handoff document does not exist");
	const bytes = await fsCall(() => fs.readBytes(target, signal, maxBytes), "failed to read the handoff document");
	let text;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new HandoffError("filesystem", "handoff document is not valid UTF-8");
	}
	return {
		text,
		version: info.version
	};
}
async function writeHandoffText(fs, root, text, signal) {
	const target = await resolveHandoffTarget(fs, root, signal);
	const info = await fsCall(() => fs.stat(target, signal), "failed to write the handoff document");
	const intent = info === void 0 ? { kind: "createIfAbsent" } : {
		kind: "replaceIfVersion",
		version: info.version
	};
	await fsCall(() => fs.writeText(target, text, intent, signal), "failed to write the handoff document");
}
//#endregion
//#region src/save.ts
async function saveTransaction(ctx, agent, config, signal, options) {
	if (signal.aborted) throw new HandoffError("cancelled", "save was cancelled");
	const surface = await ctx.sessionQuery.readSurface(agent.id);
	const messages = surface.events.flatMap((event) => {
		const message = deriveEventMessage(event);
		return message === null ? [] : [message];
	});
	let git;
	try {
		git = await captureGit(ctx.subprocess, agent.session.header.cwd ?? process.cwd(), signal, config.gitTimeoutMs);
	} catch (error) {
		if (signal.aborted) throw new HandoffError("cancelled", "save was cancelled", { cause: error });
		throw new HandoffError("git", "failed to capture git state", { cause: error });
	}
	let summarized;
	try {
		summarized = await summarizeHandoff(ctx.llm.stream.bind(ctx.llm), {
			agent,
			messages,
			config,
			env: options.env,
			signal
		});
	} catch (error) {
		if (signal.aborted) throw new HandoffError("cancelled", "save was cancelled", { cause: error });
		throw new HandoffError("model", "failed to summarize the session", { cause: error });
	}
	const changed = git.changedFiles.map((file) => redactText(file, options.env));
	const changedFiles = changed.map((result) => result.text);
	const workspace = redactText(git.relativeCwd, options.env);
	const branch = redactText(git.branch, options.env);
	const gitCounts = mergeRedactionCounts(...changed.map((result) => result.counts), workspace.counts, branch.counts);
	const redactionCounts = mergeRedactionCounts(summarized.redactions, gitCounts);
	const text = renderHandoffDocument({
		metadata: {
			generated: options.now().toISOString(),
			sourceSession: String(agent.id),
			capturedThroughSeq: surface.capturedThroughSeq,
			workspace: workspace.text,
			gitBranch: branch.text,
			gitHead: git.head,
			gitStateDigest: git.stateDigest
		},
		summary: summarized.summary,
		changedFiles,
		redactions: redactionCounts
	});
	if (Buffer.byteLength(text, "utf8") > config.maxDocumentBytes) throw new HandoffError("document", "handoff document exceeds the configured byte limit");
	await writeHandoffText(ctx.fs, git.root, text, signal);
	const redactionCount = Object.values(redactionCounts).reduce((sum, count) => sum + (count ?? 0), 0);
	return {
		path: HANDOFF_PATH,
		capturedThroughSeq: surface.capturedThroughSeq,
		digest: handoffDigest(text),
		redactionCount
	};
}
async function saveHandoff(ctx, agent, config, signal, options) {
	if (signal?.aborted === true) throw new HandoffError("cancelled", "save was cancelled");
	let maintenance;
	try {
		maintenance = agent.runMaintenance(async (maintenanceSignal) => {
			return saveTransaction(ctx, agent, config, signal === void 0 ? maintenanceSignal : AbortSignal.any([signal, maintenanceSignal]), options);
		});
	} catch {
		throw new HandoffError("busy", "agent is already running a turn or maintenance task");
	}
	return maintenance;
}
//#endregion
//#region src/load.ts
const RECALL_PLUGIN = "dsh-handoff";
const RECALL_FORM = "recall";
const RECALL_INSTRUCTION = "Treat this document as historical task context. The current repository and current user instruction take precedence. Do not assume facts from the previous session that are absent here.";
function isRecallSource(source) {
	return source.kind === "plugin" && source.plugin === RECALL_PLUGIN && source.form === RECALL_FORM;
}
function textBlocks(message) {
	return message.content.flatMap((block) => block.type === "text" ? [block.text] : []);
}
function hasMarker(message, marker) {
	return isRecallSource(message.source) && textBlocks(message).some((text) => text.includes(marker));
}
async function loadTransaction(ctx, agent, config, signal) {
	if (signal.aborted) throw new HandoffError("cancelled", "load was cancelled");
	let git;
	try {
		git = await captureGit(ctx.subprocess, agent.session.header.cwd ?? process.cwd(), signal, config.gitTimeoutMs);
	} catch (error) {
		if (signal.aborted) throw new HandoffError("cancelled", "load was cancelled", { cause: error });
		throw new HandoffError("git", "failed to capture git state", { cause: error });
	}
	const { text } = await readHandoffText(ctx.fs, git.root, config.maxDocumentBytes, signal);
	let parsed;
	try {
		parsed = parseHandoffDocument(text, config.maxDocumentBytes);
	} catch (error) {
		if (signal.aborted) throw new HandoffError("cancelled", "load was cancelled", { cause: error });
		throw new HandoffError("document", "handoff document could not be parsed", { cause: error });
	}
	const stale = git.branch !== parsed.metadata.gitBranch || git.head !== parsed.metadata.gitHead || git.stateDigest !== parsed.metadata.gitStateDigest;
	const marker = `<!-- dsh-handoff-digest:sha256:${parsed.digest} -->`;
	if ((await ctx.sessionQuery.readSurface(agent.id)).events.some((event) => {
		if (event.type !== "user/message") return false;
		return hasMarker(event.data, marker);
	})) return {
		kind: "already-loaded",
		path: HANDOFF_PATH,
		digest: parsed.digest
	};
	if (signal.aborted) throw new HandoffError("cancelled", "load was cancelled");
	const injected = [
		marker,
		"<dsh-handoff>",
		RECALL_INSTRUCTION,
		"",
		parsed.text.trimEnd(),
		"</dsh-handoff>"
	].join("\n");
	agent.session.append("user/message", createUserMessage({
		content: [{
			type: "text",
			text: injected
		}],
		source: {
			kind: "plugin",
			plugin: RECALL_PLUGIN,
			form: RECALL_FORM
		}
	}), { surfaceOp: "append" });
	return {
		kind: "loaded",
		path: HANDOFF_PATH,
		digest: parsed.digest,
		stale
	};
}
async function loadHandoff(ctx, agent, config, signal) {
	if (signal?.aborted === true) throw new HandoffError("cancelled", "load was cancelled");
	let maintenance;
	try {
		maintenance = agent.runMaintenance(async (maintenanceSignal) => {
			return loadTransaction(ctx, agent, config, signal === void 0 ? maintenanceSignal : AbortSignal.any([signal, maintenanceSignal]));
		});
	} catch {
		throw new HandoffError("busy", "agent is already running a turn or maintenance task");
	}
	return maintenance;
}
//#endregion
//#region src/command.ts
const USAGE = "Usage: /handoff save | /handoff load";
/** Fail loudly if the closed error-code union gains an unhandled member. */
function assertNever(value) {
	throw new TypeError(`unknown handoff error code: ${String(value)}`);
}
function pluralize(count) {
	return count === 1 ? "secret" : "secrets";
}
function saveText(result) {
	const seq = result.capturedThroughSeq === null ? "null" : String(result.capturedThroughSeq);
	return `Saved ${result.path} through session seq ${seq} (${result.redactionCount} ${pluralize(result.redactionCount)} redacted).`;
}
function loadText(result) {
	if (result.kind === "already-loaded") return "docs/handoffs/current.md is already loaded in this session.";
	if (result.stale) return "Loaded docs/handoffs/current.md with a repository-state warning; current files take precedence. Send the next development instruction.";
	return "Loaded docs/handoffs/current.md. Send the next development instruction.";
}
const ACK_PLUGIN = "dsh-handoff";
/**
* Ask the model to report a completed operation. A `/handoff` command renders
* as a flow node, not a conversation turn, so without this follow-up the
* assistant stays silent and a fresh thread shows nothing but the command
* lifecycle. The follow-up message is a `notice` (a one-off account of what
* just happened) and wakes the model for one short confirmation turn.
*/
function acknowledge(agent, ack) {
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: ack.instruction
		}],
		source: {
			kind: "plugin",
			plugin: ACK_PLUGIN,
			form: "notice",
			summary: ack.summary
		}
	}));
}
function handoffFailure(error) {
	switch (error.code) {
		case "busy":
		case "cancelled":
		case "git":
		case "model":
		case "document":
		case "filesystem": return {
			kind: "error",
			text: error.message
		};
		default: return assertNever(error.code);
	}
}
async function executeHandoff(ctx, invocation, config, signal) {
	const tokens = invocation.rawInput.trim().split(/\s+/u);
	const token = tokens[0];
	if (tokens.length !== 1 || token !== "save" && token !== "load") return {
		kind: "error",
		text: USAGE
	};
	try {
		if (token === "save") {
			const result = await saveHandoff(ctx, invocation.agent, config, signal, {
				env: process.env,
				now: () => /* @__PURE__ */ new Date()
			});
			acknowledge(invocation.agent, {
				summary: `Saved ${result.path}`,
				instruction: `The development handoff document was saved to ${result.path}. Briefly confirm this to the user.`
			});
			return {
				kind: "success",
				text: saveText(result)
			};
		}
		const result = await loadHandoff(ctx, invocation.agent, config, signal);
		acknowledge(invocation.agent, result.kind === "already-loaded" ? {
			summary: `Already loaded ${result.path}`,
			instruction: "The development handoff document is already loaded in this session. Briefly confirm this to the user."
		} : {
			summary: `Loaded ${result.path}`,
			instruction: "The development handoff document was loaded. Briefly confirm this to the user."
		});
		return {
			kind: "success",
			text: loadText(result)
		};
	} catch (error) {
		if (error instanceof HandoffError) return handoffFailure(error);
		throw error;
	}
}
/**
* Register the strict `/handoff save | /handoff load` command.
*
* Every invocation owns an independent AbortController fused with the UI
* request signal; the controller and its operation are tracked in one map and
* retired as soon as the operation settles, so the effect disposer aborts and
* drains exactly the work still in flight.
*/
function registerHandoffCommand(ctx, config) {
	const active = /* @__PURE__ */ new Map();
	const handler = (invocation) => {
		const controller = new AbortController();
		const operation = executeHandoff(ctx, invocation, config, AbortSignal.any([invocation.signal, controller.signal]));
		active.set(controller, operation);
		const retire = () => {
			active.delete(controller);
		};
		operation.then(retire, retire);
		return operation;
	};
	ctx.effect(function* () {
		yield async () => {
			const controllers = [...active.keys()];
			const operations = [...active.values()];
			for (const controller of controllers) controller.abort(/* @__PURE__ */ new Error("handoff command disposed"));
			await Promise.allSettled(operations);
		};
		yield ctx.commands.register({
			name: "handoff",
			description: "Save or load the development handoff document",
			input: { hint: "save | load" },
			handler
		});
	});
}
//#endregion
//#region src/index.ts
const name = "dsh-handoff";
const inject = [
	"commands",
	"sessionQuery",
	"llm",
	"fs",
	"subprocess"
];
function apply(ctx, config = {}) {
	registerHandoffCommand(ctx, resolveConfig(config));
}
//#endregion
export { Config, apply, inject, name };
