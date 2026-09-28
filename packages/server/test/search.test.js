/**
 * Search pipeline seam: query in, ranked maps and formatted text out.
 * Exercises the moved modules (queryExpander → mapFilter → resultFormatter)
 * without network; catalog parsing needs S3 and is covered by later tickets.
 */
import { describe, test, expect } from 'vitest';
import { expandQuery } from '../src/search/queryExpander.js';
import { filterMaps } from '../src/search/mapFilter.js';
import { formatSearchResults, formatSearchResultsJSON } from '../src/search/resultFormatter.js';

const maps = [
  { source: '4dn', name: 'GM12878 in situ Hi-C', url: 'https://example.org/gm12878.hic',
    metadata: { organism: 'human', assembly: 'hg38', cellType: 'GM12878' } },
  { source: 'encode', name: 'mESC Hi-C', url: 'https://example.org/mesc.hic',
    metadata: { organism: 'mouse', assembly: 'mm10', cellType: 'ES-E14' } },
];

describe('search pipeline', () => {
  test('expandQuery adds genome synonyms and keeps the original term', () => {
    const terms = expandQuery('human');
    expect(terms).toContain('human');
    expect(terms).toContain('hg38');
  });

  test('filterMaps returns every map for an empty query', () => {
    expect(filterMaps(maps, '')).toEqual(maps);
  });

  test('filterMaps matches through a synonym (grch38 → hg38) and drops the rest', () => {
    const hits = filterMaps(maps, 'grch38');
    expect(hits.map(m => m.name)).toEqual(['GM12878 in situ Hi-C']);
  });

  test('formatSearchResults lists hits in rank order with their source', () => {
    const text = formatSearchResults(filterMaps(maps, 'mouse'), 'mouse');
    expect(text).toMatch(/1 \| encode \| mESC Hi-C/);
  });

  test('formatSearchResultsJSON returns one entry per map', () => {
    const json = formatSearchResultsJSON(maps);
    expect(JSON.parse(json)).toHaveLength(2);
  });
});
