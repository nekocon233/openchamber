import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'bun:test';
import { ModelPickerList, type ModelPickerEntry } from './ModelPickerList';

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
    modelsMetadata={new Map()}
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
