import { describe, expect, it } from 'vitest';
import { buildSkillReadPart } from './skill-records.js';
import { partsForCodexItem } from './codex/items.js';
import { projectCodexTurns } from './codex/projector.js';
import { showsWithFileChangesOnly } from '@openchamber/ui/components/chat/message/parts/toolRenderUtils';

const context = { sessionId: 'ncx_thread', threadId: 'thread', messageId: 'assistant', start: 1, end: 2 };
describe('native skill and MCP provenance', () => {
  it('uses a successful manifest read, including relative paths, as loading evidence', () => {
    const part = buildSkillReadPart({ filePath: 'SKILL.md', cwd: '/skills/example', id: 'skill', sessionID: 'ncl_session', messageID: 'assistant', start: 1, end: 2 });
    expect(part).toMatchObject({ tool: 'skill', state: { input: { name: 'example' }, metadata: { dir: '/skills/example', source: 'read' } } });
    expect(buildSkillReadPart({ filePath: '/work/README.md', id: 'read' })).toBeNull();
  });
  it('shows explicit Codex skill input once and tolerates malformed unrelated items', () => {
    const records = projectCodexTurns({
      sessionId: 'ncx_thread', threadId: 'thread', cwd: '/work', threadModel: 'model',
      turns: [{ id: 'turn', status: 'completed', items: [null, { type: 'userMessage', id: 'user', content: [
        { type: 'text', text: 'Use the skill' }, { type: 'skill', name: 'example', path: '/skills/example/SKILL.md' },
      ] }] }],
    });
    expect(records.flatMap((record) => record.parts).filter((part) => part.type === 'tool' && part.tool === 'skill')).toHaveLength(1);
    expect(records.map((record) => record.info.role)).toEqual(['user', 'assistant']);
  });
  it('keeps structured MCP calls visible and preserves MCP error results', () => {
    const [part] = partsForCodexItem({ type: 'mcpToolCall', id: 'call', server: 'docs', tool: 'skill', arguments: {}, status: 'completed', result: { content: [{ text: 'Tool failed' }], isError: true } }, context);
    expect(part).toMatchObject({ tool: 'docs_skill', state: { status: 'error', metadata: { openchamberToolSource: 'mcp' } } });
    expect(showsWithFileChangesOnly(part)).toBe(true);
  });
});
