/**
 * ENCODE portal client — PROTOTYPE (branch proto/encode-portal-search).
 *
 * Live search of https://www.encodeproject.org, as opposed to the curated
 * igv-data catalogs in catalogs.js. Learned 2026-09-29 (see
 * .scratch/v2/encode-probes/):
 * - The portal sits behind AWS WAF. Any explicit User-Agent is answered in
 *   <300 ms from Cloudflare's edge; a spoofed browser UA gets a 502 from their
 *   bot filter, and no UA hangs until timeout. We keep the catalog fetch's UA.
 * - A search with no hits answers HTTP 404 with a normal JSON body (total 0).
 * - Repeating a filter key means OR; `field=` picks the returned properties,
 *   dotted names embed sub-objects (files.href …).
 * - biosample_ontology.organ_slims covers cell lines derived from the organ
 *   too (colon → HCT116), so `classification` is exposed as a filter.
 */

export const ENCODE_ORIGIN = 'https://www.encodeproject.org';
const USER_AGENT = 'Mozilla/5.0 (compatible; Juicebox-MCP/1.0)';
export const HIC_ASSAYS = ['intact Hi-C', 'in situ Hi-C', 'Hi-C', 'dilution Hi-C'];
export const CLASSIFICATIONS = ['tissue', 'cell line', 'primary cell', 'in vitro differentiated cells'];

/**
 * One portal search. `filters` values may be arrays (OR). Released items only
 * unless `filters.status` says otherwise.
 * @returns {Promise<{total: number, hits: object[], facets: object[], url: string}>}
 */
export async function encodeSearch({ type = 'Experiment', searchTerm, filters = {}, fields = [], limit = 20 }) {
  const params = new URLSearchParams({ type, format: 'json', limit: String(limit) });
  if (!('status' in filters)) params.append('status', 'released');
  if (searchTerm) params.set('searchTerm', searchTerm);
  for (const [key, value] of Object.entries(filters)) {
    for (const one of [].concat(value)) params.append(key, String(one));
  }
  for (const field of fields) params.append('field', field);
  const url = `${ENCODE_ORIGIN}/search/?${params}`;

  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(25000)
  });
  const body = response.status === 200 || response.status === 404 ? await response.json().catch(() => null) : null;
  if (!body) throw new Error(`ENCODE portal answered ${response.status} for ${url}`);

  return {
    total: body.total ?? 0,
    hits: body['@graph'] ?? [],
    facets: (body.facets ?? [])
      .filter((facet) => facet.terms?.length)
      .map((facet) => ({ field: facet.field, title: facet.title, terms: facet.terms.slice(0, 15).map((t) => ({ term: t.key, count: t.doc_count })) })),
    url
  };
}

const EXPERIMENT_FIELDS = [
  'accession', 'assay_title', 'biosample_summary', 'biosample_ontology.term_name', 'biosample_ontology.classification',
  'biosample_ontology.organ_slims', 'assembly', 'lab.title', 'description',
  'files.accession', 'files.href', 'files.file_format', 'files.output_type', 'files.assembly', 'files.status',
  'files.biological_replicates', 'files.file_size'
];
const TRACK_FORMATS = new Set(['bedpe', 'bed', 'bigBed', 'bigWig']);
const MAP_RANK = { 'mapping quality thresholded contact matrix': 0, 'contact matrix': 1 };

/**
 * Hi-C experiments first, then their files: the contact maps (`maps`, MAPQ-thresholded
 * first) and the loops / domains / stripes / compartment files the viewer can load as
 * tracks (`tracks`). Organ words go through organ_slims, anything else (cell lines,
 * free text) falls back to the portal's full-text search.
 */
export async function hicExperiments({ biosample, assay, classification, assembly, searchTerm, limit = 10 }) {
  const filters = { assay_title: assay ? [assay] : HIC_ASSAYS };
  if (classification) filters['biosample_ontology.classification'] = classification;
  if (assembly) filters.assembly = assembly;
  const fields = EXPERIMENT_FIELDS;

  let result;
  let how;
  if (biosample) {
    result = await encodeSearch({ type: 'Experiment', searchTerm, filters: { ...filters, 'biosample_ontology.organ_slims': biosample }, fields, limit });
    how = `organ "${biosample}"`;
    if (result.total === 0) {
      result = await encodeSearch({ type: 'Experiment', searchTerm: [searchTerm, biosample].filter(Boolean).join(' '), filters, fields, limit });
      how = `text "${biosample}"`;
    }
  } else {
    result = await encodeSearch({ type: 'Experiment', searchTerm, filters, fields, limit });
    how = searchTerm ? `text "${searchTerm}"` : 'no biosample filter';
  }
  // Experiments whose maps are not released yet are useless to the viewer.
  const shaped = result.hits.map(shapeExperiment);
  const experiments = shaped.filter((x) => x.maps.length > 0);
  return { total: result.total, how, url: result.url, experiments, withoutMaps: shaped.length - experiments.length };
}

function shapeExperiment(e) {
  const released = (e.files ?? []).filter((f) => f.status === 'released');
  const file = (f) => ({
    accession: f.accession,
    url: ENCODE_ORIGIN + f.href,
    format: f.file_format,
    outputType: f.output_type,
    assembly: f.assembly,
    replicates: f.biological_replicates ?? [],
    sizeGB: f.file_size ? Number((f.file_size / 1e9).toFixed(1)) : undefined
  });
  const maps = released.filter((f) => f.file_format === 'hic').map(file)
    .sort((a, b) => (MAP_RANK[a.outputType] ?? 2) - (MAP_RANK[b.outputType] ?? 2) || String(a.replicates) .localeCompare(String(b.replicates)));
  const tracks = released.filter((f) => TRACK_FORMATS.has(f.file_format)).map(file)
    .sort((a, b) => a.format.localeCompare(b.format) || a.outputType.localeCompare(b.outputType));
  return {
    accession: e.accession,
    portalUrl: `${ENCODE_ORIGIN}/experiments/${e.accession}/`,
    assay: e.assay_title,
    biosample: e.biosample_ontology?.term_name,
    classification: e.biosample_ontology?.classification,
    organs: e.biosample_ontology?.organ_slims ?? [],
    summary: e.biosample_summary,
    assembly: e.assembly ?? [],
    lab: e.lab?.title,
    description: e.description,
    maps,
    tracks
  };
}

/** Text for the model: one block per experiment, then compact JSON with the loadable URLs. */
const MAPS_SHOWN = 3;   // some experiments carry 10+ replicate matrices
const MAPS_IN_JSON = 6;

export function formatHicExperiments({ total, how, experiments, withoutMaps }) {
  const omitted = withoutMaps ? ` (${withoutMaps} without released maps omitted)` : '';
  if (experiments.length === 0) return `No released ENCODE Hi-C experiments with maps found (${how})${omitted}.`;
  const gb = (f) => (f.sizeGB ? ` ${f.sizeGB} GB` : '');
  const trackSummary = (tracks) => {
    const byFormat = {};
    for (const t of tracks) (byFormat[t.format] ??= new Set()).add(t.outputType);
    return Object.entries(byFormat).map(([format, types]) => `${format}: ${[...types].join(', ')}`).join('; ');
  };
  const blocks = experiments.map((x, i) => [
    `${i + 1}. ${x.accession} — ${x.assay} — ${x.summary ?? x.biosample} [${x.classification}; ${x.assembly.join(', ')}; ${x.lab}]`,
    ...x.maps.slice(0, MAPS_SHOWN).map((m) => `   map: ${m.outputType} (${m.assembly}, rep ${m.replicates.join(',') || '?'}${gb(m)}) ${m.url}`),
    ...(x.maps.length > MAPS_SHOWN ? [`   (+${x.maps.length - MAPS_SHOWN} more map files)`] : []),
    ...(x.tracks.length ? [`   tracks (${x.tracks.length}, urls in the JSON): ${trackSummary(x.tracks)}`] : [])
  ].join('\n'));
  const json = experiments.map((x) => ({
    accession: x.accession, biosample: x.biosample, classification: x.classification, assay: x.assay, assembly: x.assembly,
    maps: x.maps.slice(0, MAPS_IN_JSON).map(({ url, outputType, assembly, replicates, sizeGB }) => ({ url, outputType, assembly, replicates, sizeGB })),
    tracks: x.tracks.map(({ url, format, outputType, assembly, replicates }) => ({ url, format, outputType, assembly, replicates }))
  }));
  return `${experiments.length} of ${total} released ENCODE Hi-C experiments (${how})${omitted}:\n\n${blocks.join('\n\n')}\n\n[Structured data]\n${JSON.stringify(json)}`;
}

/** Text for the model: generic hits (whatever columns the portal returns) plus its facets. */
export function formatEncodeSearch({ total, hits, facets, url }, { type }) {
  const summarise = (hit) => {
    const parts = [hit.accession, [hit.file_format, hit.output_type].filter(Boolean).join(' '), hit.assay_title, hit.title,
      hit.biosample_summary ?? hit.summary, hit.target?.label && `target ${hit.target.label}`, hit.assembly, hit.lab?.title, hit.description].filter(Boolean);
    const link = hit.href ? `${ENCODE_ORIGIN}${hit.href}` : `${ENCODE_ORIGIN}${hit['@id']}`;
    return `- ${parts.join(' — ')}\n  ${link}`;
  };
  const facetText = facets.slice(0, 8).map((f) => `${f.title ?? f.field}: ${f.terms.slice(0, 8).map((t) => `${t.term} (${t.count})`).join(', ')}`).join('\n');
  return `${hits.length} of ${total} ${type} hits on the ENCODE portal\n${url}\n\n${hits.map(summarise).join('\n') || '(none)'}\n\nFacets (narrow with filters):\n${facetText}`;
}
