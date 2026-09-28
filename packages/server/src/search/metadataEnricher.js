/**
 * Metadata Enrichment Module
 * 
 * Adds computed fields to map entries to aid search and reasoning.
 * Enriched fields are prefixed with `_` to distinguish from original metadata.
 */

/**
 * Extract species name from Biosource or Biosample
 * @param {string} biosource - Biosource value
 * @param {string} biosample - Biosample value
 * @returns {string} Normalized species name (e.g., "human", "mouse") or empty string
 */
function extractSpecies(biosource, biosample) {
  const text = `${biosource || ''} ${biosample || ''}`.toLowerCase();
  
  if (text.includes('homo sapiens') || text.includes('human')) {
    return 'human';
  }
  if (text.includes('mus musculus') || text.includes('mouse')) {
    return 'mouse';
  }
  if (text.includes('drosophila') || text.includes('fly')) {
    return 'fly';
  }
  if (text.includes('caenorhabditis') || text.includes('elegans') || text.includes('worm')) {
    return 'worm';
  }
  if (text.includes('saccharomyces') || text.includes('cerevisiae') || text.includes('yeast')) {
    return 'yeast';
  }
  
  return '';
}

/**
 * Categorize cell type based on Biosource or Biosample
 * @param {string} biosource - Biosource value
 * @param {string} biosample - Biosample value
 * @returns {string} Category ("cancer", "normal", "stem", or empty string)
 */
function categorizeCellType(biosource, biosample) {
  const text = `${biosource || ''} ${biosample || ''}`.toLowerCase();
  
  // Cancer cell lines
  const cancerPatterns = ['k562', 'hela', 'hela-s3', 'mcf-7', 'a549', 'hepg2', 'cancer', 'tumor'];
  if (cancerPatterns.some(pattern => text.includes(pattern))) {
    return 'cancer';
  }
  
  // Stem cells
  const stemPatterns = ['ipsc', 'ips', 'esc', 'embryonic stem', 'pluripotent'];
  if (stemPatterns.some(pattern => text.includes(pattern))) {
    return 'stem';
  }
  
  // Normal/primary cells
  const normalPatterns = ['gm12878', 'imr90', 'normal', 'primary', 'fibroblast', 'lymphoblastoid'];
  if (normalPatterns.some(pattern => text.includes(pattern))) {
    return 'normal';
  }
  
  return '';
}

/**
 * Normalize assembly name to standard format
 * @param {string} assembly - Assembly value
 * @returns {string} Normalized assembly name
 */
function normalizeAssembly(assembly) {
  if (!assembly) return '';
  
  const normalized = assembly.toLowerCase().trim();
  
  // Map common names to standard formats
  const assemblyMap = {
    'hg38': 'GRCh38',
    'grch38': 'GRCh38',
    'hg19': 'GRCh37',
    'grch37': 'GRCh37',
    'hg37': 'GRCh37',
    'mm10': 'GRCm38',
    'grcm38': 'GRCm38',
    'mm39': 'GRCm39',
    'grcm39': 'GRCm39',
    'mm9': 'GRCm37',
    'grcm37': 'GRCm37',
  };
  
  return assemblyMap[normalized] || assembly; // Return normalized or original
}

/**
 * Determine if data is recent based on Accession patterns
 * This is a heuristic - newer accessions might indicate more recent data
 * @param {string} accession - Accession value
 * @returns {boolean} True if appears to be recent
 */
function isRecentData(accession) {
  if (!accession) return false;
  
  // Very simple heuristic: if accession contains recent-looking patterns
  // This could be enhanced with actual date parsing if dates are available
  // For now, default to false to avoid false positives
  return false;
}

/**
 * Create searchable text from all metadata fields
 * @param {Object} map - Map entry
 * @returns {string} Concatenated searchable text
 */
function createSearchableText(map) {
  const parts = [];
  
  // Add name
  if (map.name) {
    parts.push(map.name);
  }
  
  // Add all metadata values
  if (map.metadata) {
    for (const value of Object.values(map.metadata)) {
      if (value && typeof value === 'string' && value.trim().length > 0) {
        parts.push(value);
      }
    }
  }
  
  return parts.join(' ').toLowerCase();
}

/**
 * Enrich a single map entry with computed fields
 * @param {Object} map - Map entry to enrich
 * @returns {Object} Enriched map entry
 */
export function enrichMapMetadata(map) {
  if (!map) return map;
  
  const biosource = map.metadata?.Biosource || map.metadata?.biosource || '';
  const biosample = map.metadata?.Biosample || map.metadata?.biosample || '';
  const assembly = map.metadata?.Assembly || map.metadata?.assembly || '';
  const accession = map.metadata?.Accession || map.metadata?.accession || '';
  
  // Create enriched metadata object
  const enriched = {
    ...map,
    metadata: {
      ...map.metadata,
      // Add enriched fields (prefixed with _)
      _species: extractSpecies(biosource, biosample),
      _cellTypeCategory: categorizeCellType(biosource, biosample),
      _normalizedAssembly: normalizeAssembly(assembly),
      _isRecent: isRecentData(accession),
      _searchableText: createSearchableText(map),
    }
  };
  
  return enriched;
}

/**
 * Enrich an array of map entries
 * @param {Array<Object>} maps - Array of map entries
 * @returns {Array<Object>} Array of enriched map entries
 */
export function enrichMaps(maps) {
  if (!Array.isArray(maps)) {
    return maps;
  }
  
  return maps.map(map => enrichMapMetadata(map));
}
