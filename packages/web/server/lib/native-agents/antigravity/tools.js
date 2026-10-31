import { z } from 'zod';
import { decodeAgyToolArguments } from './protocol.js';

const command = z.object({ CommandLine: z.string() });
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
const aliases = {
  run_command: 'bash', read_file: 'read', view_file: 'read', write_file: 'write', write_to_file: 'write',
  edit_file: 'edit', replace_file_content: 'edit', multi_replace_file_content: 'edit', invoke_subagent: 'task',
};

/** Translate native argument names once, for history and streaming tool cards. */
export const mapAgyTool = (call) => {
  const { parameters, title } = decodeAgyToolArguments(call.args, call.argumentsEncoded ?? true);
  const tool = Object.hasOwn(aliases, call.name) ? aliases[call.name] : call.name;
  if (call.name === 'run_command') {
    const parsed = command.safeParse(parameters);
    if (parsed.success) return { tool: 'bash', input: { command: parsed.data.CommandLine }, title: title ?? parsed.data.CommandLine.split('\n')[0] };
  }
  if (call.name === 'read_file' || call.name === 'view_file') {
    const parsed = read.safeParse(parameters);
    if (parsed.success) return { tool: 'read', input: { ...parameters, filePath: parsed.data }, title: title ?? parsed.data };
  }
  if (call.name === 'write_file' || call.name === 'write_to_file') {
    const parsed = write.safeParse(parameters);
    if (parsed.success) return { tool: 'write', input: parsed.data, title: title ?? parsed.data.filePath };
  }
  if (call.name === 'edit_file' || call.name === 'replace_file_content') {
    const parsed = edit.safeParse(parameters);
    if (parsed.success) return { tool: 'edit', input: parsed.data, title: title ?? parsed.data.filePath };
  }
  if (['read', 'edit', 'write'].includes(tool)) {
    const parsed = read.safeParse(parameters);
    if (parsed.success) return { tool, input: { ...parameters, filePath: parsed.data }, title: title ?? parsed.data };
  }
  return { tool, input: parameters, title: title ?? call.name };
};
