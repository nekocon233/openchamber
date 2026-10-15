import { describe, expect, test } from 'bun:test';
import { readQuestionTranscript } from './questionTranscript';

describe('native question transcript', () => {
  test('keeps multiple selections and arbitrary quoted or multiline custom answers', () => {
    expect(readQuestionTranscript({ questions: [
      { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Explain' },
    ] }, { questionAnswers: [['A', 'B'], ['"quoted"\n第二行']], questionResponse: 'Additional "notes"\n第三行' })).toEqual({ questions: [
      { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }], answers: ['A', 'B'] },
      { question: 'Explain', options: [], answers: ['"quoted"\n第二行'] },
    ], response: 'Additional "notes"\n第三行' });
  });
  test('leaves legacy and malformed answers to the existing renderer', () => {
    expect(readQuestionTranscript({ questions: [] }, undefined)).toBeNull();
    expect(readQuestionTranscript({ questions: [{ question: 'Q' }] }, { questionAnswers: ['invalid'] })).toBeNull();
  });
});
