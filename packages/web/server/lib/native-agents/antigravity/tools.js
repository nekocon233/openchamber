import { z } from 'zod';
import { decodeAgyToolArguments } from './protocol.js';
import { fileDiffMetadata } from '../file-diff.js';
import { agyInteractionTruncated } from './interaction-signals.js';

const command = z.object({ CommandLine: z.string() });
const search = z.object({ query: z.string() });
const mcp = z.object({ ServerName: z.string().min(1), ToolName: z.string().min(1), Arguments: z.record(z.string(), z.json()) });
const read = z.union([
  z.object({ Path: z.string() }).transform((input) => input.Path),
  z.object({ AbsolutePath: z.string() }).transform((input) => input.AbsolutePath),
  z.object({ TargetFile: z.string() }).transform((input) => input.TargetFile),
]);
const write = z.union([
  z.object({ Path: z.string(), Content: z.string() }).transform((input) => ({ filePath: input.Path, content: input.Content })),
  z.object({ TargetFile: z.string(), CodeContent: z.string() }).transform((input) => ({ filePath: input.TargetFile, content: input.CodeContent })),
]);
const edit = z.union([
  z.object({ Path: z.string(), Target: z.string(), Replacement: z.string() })
    .transform((input) => ({ filePath: input.Path, oldString: input.Target, newString: input.Replacement })),
  z.object({ TargetFile: z.string(), TargetContent: z.string(), ReplacementContent: z.string() })
    .transform((input) => ({ filePath: input.TargetFile, oldString: input.TargetContent, newString: input.ReplacementContent })),
]);
const chunks = z.object({ TargetFile: z.string(), ReplacementChunks: z.array(z.object({
  TargetContent: z.string(), ReplacementContent: z.string(),
})).min(1) }).transform((input) => ({ filePath: input.TargetFile,
  edits: input.ReplacementChunks.map((chunk) => ({ oldString: chunk.TargetContent, newString: chunk.ReplacementContent })),
}));
const readRange = z.object({ StartLine: z.number().int().positive(), EndLine: z.number().int().positive().optional() });
const aliases = {
  run_command: 'bash', read_file: 'read', view_file: 'read', write_file: 'write', write_to_file: 'write',
  edit_file: 'edit', replace_file_content: 'edit', multi_replace_file_content: 'edit', invoke_subagent: 'task', search_web: 'websearch',
};

/** Translate native argument names once, for history and streaming tool cards. */
export const mapAgyTool = (call) => {
  const { parameters, title } = decodeAgyToolArguments(call.args, call.argumentsEncoded ?? true);
  if (call.name === 'call_mcp_tool') {
    const parsed = mcp.safeParse(parameters);
    if (parsed.success) return { tool: `${parsed.data.ServerName}_${parsed.data.ToolName}`,
      input: parsed.data.Arguments, title: title ?? parsed.data.ToolName, metadata: { openchamberToolSource: 'mcp' } };
  }
  const tool = Object.hasOwn(aliases, call.name) ? aliases[call.name] : call.name;
  if (call.name === 'run_command') {
    const parsed = command.safeParse(parameters);
    if (parsed.success) return { tool: 'bash', input: { command: parsed.data.CommandLine }, title: title ?? parsed.data.CommandLine.split('\n')[0] };
  }
  if (call.name === 'read_file' || call.name === 'view_file') {
    const parsed = read.safeParse(parameters);
    if (parsed.success) {
      const range = readRange.safeParse(parameters);
      const input = { ...parameters, filePath: parsed.data };
      if (range.success) {
        input.offset = range.data.StartLine;
        if (range.data.EndLine !== undefined && range.data.EndLine >= range.data.StartLine) input.limit = range.data.EndLine - range.data.StartLine + 1;
      }
      return { tool: 'read', input, title: title ?? parsed.data };
    }
  }
  if (call.name === 'write_file' || call.name === 'write_to_file') {
    const parsed = write.safeParse(parameters);
    if (parsed.success) return { tool: 'write', input: parsed.data, title: title ?? parsed.data.filePath };
  }
  if (call.name === 'edit_file' || call.name === 'replace_file_content') {
    const parsed = edit.safeParse(parameters);
    if (parsed.success) return { tool: 'edit', input: parsed.data, title: title ?? parsed.data.filePath };
  }
  if (call.name === 'multi_replace_file_content') {
    const parsed = chunks.safeParse(parameters);
    if (parsed.success) return { tool: 'edit', input: parsed.data, title: title ?? parsed.data.filePath };
  }
  if (call.name === 'search_web') {
    const parsed = search.safeParse(parameters);
    if (parsed.success) return { tool, input: parameters, title: title ?? parsed.data.query };
  }
  if (['read', 'edit', 'write'].includes(tool)) {
    const parsed = read.safeParse(parameters);
    if (parsed.success) return { tool, input: { ...parameters, filePath: parsed.data }, title: title ?? parsed.data };
  }
  return { tool, input: parameters, title: title ?? call.name };
};

const replacement = z.object({ oldString: z.string(), newString: z.string() });
const excerptInput = z.object({ filePath: z.string(), edits: z.array(replacement).optional(), oldString: z.string().optional(), newString: z.string().optional() });
const writeContentInput = z.object({ content: z.string() });
const rawArgsRecord = z.record(z.string(), z.unknown());
const linesOf = (text) => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
const fileArgTools = new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_file', 'write_to_file']);

/** True when the step, call, or file-tool arguments carry native truncation markers. */
export const agyToolInputTruncated = (call, inputTruncated = false) => {
  if (inputTruncated || agyInteractionTruncated(call)) return true;
  if (!fileArgTools.has(call?.name)) return false;
  const parsedArgs = rawArgsRecord.safeParse(call?.args);
  if (!parsedArgs.success) return true;
  const { parameters } = decodeAgyToolArguments(parsedArgs.data, call.argumentsEncoded ?? true);
  return agyInteractionTruncated(parameters);
};

/** These are replacement excerpts, with no recorded position in the whole file. */
export const agyEditMetadata = (call, { completed, inputTruncated = false }) => {
  if (!completed || agyToolInputTruncated(call, inputTruncated)) return {};
  const mapped = mapAgyTool(call);
  if (mapped.tool !== 'edit') return {};
  const parsed = excerptInput.safeParse(mapped.input);
  if (!parsed.success) return {};
  const single = replacement.safeParse(parsed.data);
  const edits = parsed.data.edits ?? (single.success ? [single.data] : []);
  const files = edits.map(({ oldString, newString }) => {
    const before = linesOf(oldString);
    const after = linesOf(newString);
    const body = [
      ...before.map((line) => `-${line}`),
      ...(before.length && !oldString.endsWith('\n') ? ['\\ No newline at end of file'] : []),
      ...after.map((line) => `+${line}`),
      ...(after.length && !newString.endsWith('\n') ? ['\\ No newline at end of file'] : []),
    ].join('\n');
    return { filePath: parsed.data.filePath, type: 'update', additions: after.length, deletions: before.length,
      diff: `--- ${parsed.data.filePath}\n+++ ${parsed.data.filePath}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n${body}\n`,
    };
  });
  return files.length ? { ...fileDiffMetadata(files), nativeDiffScope: 'replacement' } : {};
};

/** Completed stream edits and writes carry only a path or truncated text until complete native arguments are read. */
export const agyMissingFileDetails = (part) => part?.type === 'tool'
  && part.state.status === 'completed'
  && part.state.metadata?.nativeBackend === 'antigravity'
  && ((part.tool === 'edit' && !part.state.metadata?.diff)
    || (part.tool === 'write' && (!writeContentInput.safeParse(part.state.input).success || Boolean(part.state.metadata?.nativeInputTruncated))));

/** Fill a completed stream edit or write from complete native arguments, preserving its outcome and timing. */
export const withAgyFileDetails = (live, saved) => {
  if (!agyMissingFileDetails(live) || saved?.type !== 'tool' || live.tool !== saved.tool
    || live.id !== saved.id || live.messageID !== saved.messageID
    || saved.state.status !== 'completed' || saved.state.metadata?.nativeInputTruncated) return live;
  const input = saved.state.input?.filePath ? saved.state.input : { ...live.state.input, ...saved.state.input };
  if (live.tool === 'edit') {
    if (!saved.state.metadata?.diff) return live;
    const { files, diff, nativeDiffScope } = saved.state.metadata;
    const metadata = { ...live.state.metadata, files, diff, nativeDiffScope };
    delete metadata.nativeInputTruncated;
    return { ...live, state: { ...live.state, input, metadata } };
  }
  if (!writeContentInput.safeParse(saved.state.input).success) return live;
  const metadata = { ...live.state.metadata };
  delete metadata.nativeInputTruncated;
  return { ...live, state: { ...live.state, input, metadata } };
};
