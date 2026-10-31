import { expect, test } from 'bun:test';
import { editorWidthForRatio } from './editorSplit';

test('splits evenly until either editor or chat reaches its minimum', () => {
  expect(editorWidthForRatio(1200, 0.5)).toBe(600);
  expect(editorWidthForRatio(1000, 0.1)).toBe(320);
  expect(editorWidthForRatio(1000, 0.9)).toBe(600);
  expect(editorWidthForRatio(720, 0.5)).toBe(320);
  expect(editorWidthForRatio(720, 0.8)).toBe(320);
});
