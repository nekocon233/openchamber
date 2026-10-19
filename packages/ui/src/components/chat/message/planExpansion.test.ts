import { expect, test } from 'bun:test';
import { createPlanExpansionState } from './planExpansion';

test('retains explicit closed and open choices independently of changing defaults', () => {
    const state = createPlanExpansionState();
    expect(state.read('plan')).toBeUndefined();
    state.toggle('plan', true);
    expect(state.read('plan')).toBe(false);
    state.toggle('plan', false);
    expect(state.read('plan')).toBe(true);
    expect(state.read('another-plan')).toBeUndefined();
});

test('notifies only the plan whose disclosure changed', () => {
    const state = createPlanExpansionState();
    let first = 0;
    let other = 0;
    const unsubscribe = state.subscribe('first', () => first++);
    state.subscribe('other', () => other++);
    state.toggle('first', true);
    expect([first, other]).toEqual([1, 0]);
    unsubscribe();
    state.toggle('first', true);
    expect([first, other]).toEqual([1, 0]);
});

test('bounds retained choices without evicting a displayed plan', () => {
    const state = createPlanExpansionState(2);
    const unsubscribe = state.subscribe('visible', () => {});
    state.toggle('visible', true);
    state.toggle('old', true);
    state.toggle('new', true);
    expect(state.read('visible')).toBe(false);
    expect(state.read('old')).toBeUndefined();
    expect(state.read('new')).toBe(false);
    unsubscribe();
});
