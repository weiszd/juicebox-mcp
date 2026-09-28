/**
 * Query Expansion Module
 * 
 * Expands user queries with synonyms and related terms to improve semantic search.
 */

/**
 * Synonym dictionary for genomics and biology terms
 * Maps terms to arrays of related synonyms/expansions
 */
const SYNONYM_DICTIONARY = {
  // Species - human
  'human': ['homo sapiens', 'hg38', 'hg19', 'hg37', 'grch38', 'grch37'],
  'homo sapiens': ['human', 'hg38', 'hg19', 'hg37', 'grch38', 'grch37'],
  'hg38': ['human', 'homo sapiens', 'grch38'],
  'hg19': ['human', 'homo sapiens', 'grch37'],
  'grch38': ['human', 'homo sapiens', 'hg38'],
  'grch37': ['human', 'homo sapiens', 'hg19'],
  
  // Species - mouse
  'mouse': ['mus musculus', 'mm10', 'mm39', 'mm9', 'grcm38', 'grcm39'],
  'mus musculus': ['mouse', 'mm10', 'mm39', 'mm9', 'grcm38', 'grcm39'],
  'mm10': ['mouse', 'mus musculus', 'grcm38'],
  'mm39': ['mouse', 'mus musculus', 'grcm39'],
  'grcm38': ['mouse', 'mus musculus', 'mm10'],
  'grcm39': ['mouse', 'mus musculus', 'mm39'],
  
  // Common cell line aliases
  'k562': ['k-562'],
  'hela': ['hela-s3'],
  'gm12878': ['gm-12878', 'lymphoblastoid'],
  'imr90': ['imr-90', 'fibroblast'],
  
  // Assembly version aliases
  'hg37': ['hg19', 'grch37'],
  'mm9': ['grcm37'],
  
  // Common terms
  'hi-c': ['hic', 'hi c', 'contact map'],
  'contact': ['contact map', 'hic', 'hi-c'],
  '4dn': ['4d nucleome', 'fourdn'],
  'encode': ['encode project'],
};

/**
 * Expand a single term using the synonym dictionary
 * @param {string} term - Term to expand
 * @returns {string[]} Array of expanded terms (includes original term)
 */
function expandTerm(term) {
  if (!term || term.length === 0) {
    return [];
  }
  
  const normalizedTerm = term.toLowerCase().trim();
  
  // Check if term exists in dictionary
  const expansions = SYNONYM_DICTIONARY[normalizedTerm];
  
  if (expansions) {
    // Return original term plus expansions (deduplicated)
    const allTerms = [normalizedTerm, ...expansions];
    return [...new Set(allTerms)]; // Remove duplicates
  }
  
  // No expansion found, return original term
  return [normalizedTerm];
}

/**
 * Expand a query string into multiple search terms
 * @param {string} query - User's search query
 * @returns {string[]} Array of expanded search terms
 */
export function expandQuery(query) {
  if (!query || !query.trim()) {
    return [];
  }
  
  // Split query into individual terms
  const terms = query.trim().split(/\s+/).filter(term => term.length > 0);
  
  if (terms.length === 0) {
    return [];
  }
  
  // Expand each term and collect all expansions
  const expandedTerms = new Set();
  
  for (const term of terms) {
    const expansions = expandTerm(term);
    for (const expandedTerm of expansions) {
      expandedTerms.add(expandedTerm);
    }
  }
  
  return Array.from(expandedTerms);
}

/**
 * Get all synonyms for a term (for testing/debugging)
 * @param {string} term - Term to look up
 * @returns {string[]} Array of synonyms, or empty array if not found
 */
export function getSynonyms(term) {
  if (!term) return [];
  return SYNONYM_DICTIONARY[term.toLowerCase()] || [];
}
