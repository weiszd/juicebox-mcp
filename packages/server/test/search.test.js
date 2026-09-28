/**
 * Search pipeline seam: query in, ranked maps and formatted text out.
 * Exercises the moved modules (queryExpander → mapFilter → resultFormatter)
 * without network, and parses rows copied from the live igv-data catalogs
 * through the juicebox-web column lists.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';
import { getDataSource } from '../src/search/dataSourceConfigs.js';
import { parseDataSource } from '../src/search/dataParsers.js';
import encodeTsv from './fixtures/encode-hic.txt?raw';
import fourdnTsv from './fixtures/4dn-hic.txt?raw';
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

/** Serve `tsv` for the catalog fetch, parse it, and report which URL was fetched. */
async function parseFixture(sourceId, tsv) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(tsv));
  const maps = await parseDataSource(sourceId, false);
  return { maps, fetched: fetchSpy.mock.calls[0][0] };
}

describe('catalogs copied from juicebox-web', () => {
  afterEach(() => vi.restoreAllMocks());

  test.each([
    ['encode', encodeTsv, 'https://raw.githubusercontent.com/igvteam/igv-data/main/data/encode/hic.txt'],
    ['4dn', fourdnTsv, 'https://raw.githubusercontent.com/igvteam/igv-data/main/data/4dn/4dn_hic.txt'],
  ])('%s: every catalog column is in the live TSV header, and the catalog URL is fetched', async (sourceId, tsv, url) => {
    const config = getDataSource(sourceId);
    const header = tsv.split('\n')[0].split('\t');
    expect(config.columns.filter((c) => !header.includes(c))).toEqual([]);
    expect(header).toContain(typeof config.urlColumn === 'string' ? config.urlColumn : header[config.urlColumn]);
    expect(header).toContain(config.nameColumn);
    expect((await parseFixture(sourceId, tsv)).fetched).toBe(url);
  });

  test('an ENCODE row parses to an absolute URL, its Description as name, and enriched metadata', async () => {
    const [map] = (await parseFixture('encode', encodeTsv)).maps;
    expect(map).toMatchObject({
      source: 'encode',
      url: 'https://www.encodeproject.org/files/ENCFF706SFK/@@download/ENCFF706SFK.hic',
      name: 'HMEC dilution Hi-C',
      metadata: {
        Assembly: 'hg19', Biosample: 'Homo sapiens mammary epithelial cell female',
        Lab: 'Erez Aiden, Baylor', Accession: 'ENCFF706SFK', Experiment: 'ENCSR080ODG',
        _species: 'human', _normalizedAssembly: 'GRCh37',
      },
    });
  });

  test('a 4DN row parses to its url column, its Dataset as name, and enriched metadata', async () => {
    const [map] = (await parseFixture('4dn', fourdnTsv)).maps;
    expect(map).toMatchObject({
      source: '4dn',
      url: 'https://4dn-open-data-public.s3.amazonaws.com/fourfront-webprod/wfoutput/3be17688-cbce-4ef9-9b94-8571c20a858e/4DNFI916JQ1Y.hic',
      name: 'Hi-C on mouse cerebellar granule neurons',
      metadata: {
        Project: '4DN', Assembly: 'GRCm38', Biosource: 'cerebellar granule neuron - 14 days old',
        Assay: 'MboI', Replicate: 'merged replicates', Lab: 'Tomoko Yamada, NW',
        Accession: '4DNFI916JQ1Y', Experiment: 'DNESDADW6RV', _normalizedAssembly: 'GRCm38',
      },
    });
  });

  test('parsed catalog rows are searchable by column values, best match first', async () => {
    const { maps } = await parseFixture('encode', encodeTsv);
    expect(filterMaps(maps, 'HMEC')[0].metadata.Accession).toBe('ENCFF706SFK');
  });
});
