import { describe, expect, it } from 'vitest';
import { agyProcessArgs } from './process.js';

describe('Antigravity native execution modes', () => {
  it('does not request full access while discovering a new session before its first selected mode', () => {
    const args = agyProcessArgs({ cwd: '/project', agent: null });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--mode');
  });

  it('uses native plan expansion and session-only deny rules without full-access approval', () => {
    const args = agyProcessArgs({ cwd: '/project', agent: 'plan', effort: 'high' });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--disable-slash-commands=false');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({
      agentMode: 'plan', toolPermission: 'request-review',
      permissions: { deny: ['write_file(*)', 'command(*)', 'mcp(*)', 'execute_url(*)'] },
    });
  });

  it('explicitly leaves saved plan mode when the user chooses build', () => {
    const args = agyProcessArgs({ cwd: '/project', agent: 'build' });
    expect(args[args.indexOf('--mode') + 1]).toBe('accept-edits');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--settings');
  });
});
