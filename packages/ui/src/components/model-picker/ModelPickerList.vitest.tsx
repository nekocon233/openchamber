import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { ModelPickerList, type ModelPickerEntry } from './ModelPickerList';
import { buildNativeProvider } from '@/lib/native-agents/providers';
import { Icon } from '@/components/icon/Icon';

const autoEntry: ModelPickerEntry = {
  kind: 'auto',
  providerID: 'openchamber',
  modelID: 'auto',
  model: { id: 'auto', name: 'Auto' },
};

const renderAutoPicker = (searchQuery: string) => renderToStaticMarkup(
  <ModelPickerList
    providers={[]}
    favoriteModels={[]}
    recentModels={[]}
    leadingEntry={autoEntry}
    searchQuery={searchQuery}
    onSearchQueryChange={() => {}}
    onSelect={() => {}}
    labels={{ searchPlaceholder: 'Search', noResults: 'No models', favorites: 'Favorites', recent: 'Recent', keyboardHint: '' }}
  />,
);

test('renders the Auto entry without SDK model capabilities or a provider catalog', () => {
  const markup = renderAutoPicker('');
  expect(markup).toContain('Auto');
  expect(markup).not.toContain('No models');
});

test('filters Auto by its display name', () => {
  expect(renderAutoPicker('aut')).not.toContain('No models');
  expect(renderAutoPicker('unavailable-model')).toContain('No models');
});

const renderCombinationPicker = (searchQuery: string, disabled = false) => renderToStaticMarkup(
  <ModelPickerList providers={[]} favoriteModels={[]} recentModels={[]} searchQuery={searchQuery}
    onSearchQueryChange={() => {}} onSelect={() => {}}
    actionGroup={{ id: 'combinations', label: '组合', actions: [{ id: 'mixed', label: 'Mixed team', disabled, onSelect: () => {} }] }}
    labels={{ searchPlaceholder: 'Search', noResults: 'No models', favorites: 'Favorites', recent: 'Recent', keyboardHint: '' }} />,
);

test('shows named combinations as a model-picker group without provider or subagent controls', () => {
  const markup = renderCombinationPicker('');
  expect(markup).toContain('aria-label="组合"');
  expect(markup).toContain('Mixed team');
  expect(markup).not.toContain('No models');
  expect(markup).not.toContain('CLI default');
});

test('filters combinations by their name or group label', () => {
  expect(renderCombinationPicker('Mixed')).toContain('Mixed team');
  expect(renderCombinationPicker('组合')).toContain('Mixed team');
  expect(renderCombinationPicker('missing')).not.toContain('Mixed team');
});

test('retains disabled combination rows without reporting an empty result', () => {
  const markup = renderCombinationPicker('', true);
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).toContain('Mixed team');
  expect(markup).not.toContain('No models');
});

test('a selected combination is the sole selected row even when its main model is listed', () => {
  const markup = renderToStaticMarkup(<ModelPickerList
    providers={[buildNativeProvider('claude', [{ id: 'opus', name: 'Opus', efforts: ['high'], defaultEffort: 'high',
      contextWindow: 64000, outputLimit: 8192, fast: false, input: { image: false, pdf: false } }])]}
    favoriteModels={[]} recentModels={[]} searchQuery="" onSearchQueryChange={() => {}} onSelect={() => {}}
    selectedModel={null}
    actionGroup={{ id: 'combinations', label: '组合', actions: [{ id: 'mixed', label: 'Mixed team', selected: true, onSelect: () => {} }] }}
    labels={{ searchPlaceholder: 'Search', noResults: 'No models', favorites: 'Favorites', recent: 'Recent', keyboardHint: '' }} />);
  expect(markup).toContain('Mixed team');
  expect(markup).toContain('Opus');
  expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
});

test('places the combination group and its icon after Recent', () => {
  const provider = buildNativeProvider('claude', [{ id: 'opus', name: 'Opus', efforts: [], defaultEffort: null,
    contextWindow: 64000, outputLimit: 8192, fast: false, input: { image: false, pdf: false } }]);
  const markup = renderToStaticMarkup(<ModelPickerList providers={[provider]} favoriteModels={[]}
    recentModels={[{ providerID: provider.id, modelID: 'opus', model: provider.models[0] }]}
    searchQuery="" onSearchQueryChange={() => {}} onSelect={() => {}}
    actionGroup={{ id: 'combinations', label: '组合', icon: <Icon name="stack" />, actions: [{ id: 'mixed', label: 'Mixed team', onSelect: () => {} }] }}
    labels={{ searchPlaceholder: 'Search', noResults: 'No models', favorites: 'Favorites', recent: 'Recent picks', keyboardHint: '' }} />);
  expect(markup.indexOf('Recent picks')).toBeLessThan(markup.indexOf('aria-label="组合"'));
  expect(markup).toContain('href="#oc-stack"');
});

test('renders favorite combinations without requiring synthetic model records', () => {
  const markup = renderToStaticMarkup(<ModelPickerList providers={[]} favoriteModels={[]} recentModels={[]}
    favoriteActions={[{ id: 'mixed', label: 'Mixed team', favorite: true, onSelect: () => {}, onToggleFavorite: () => {}, icon: <Icon name="stack" /> }]}
    searchQuery="" onSearchQueryChange={() => {}} onSelect={() => {}}
    labels={{ searchPlaceholder: 'Search', noResults: 'No models', favorites: 'Favorites', recent: 'Recent', keyboardHint: '', favorite: 'Favorite', unfavorite: 'Unfavorite' }} />);
  expect(markup).toContain('aria-label="Favorites"');
  expect(markup).toContain('Mixed team');
  expect(markup).toContain('aria-label="Unfavorite"');
  expect(markup).not.toContain('No models');
});
