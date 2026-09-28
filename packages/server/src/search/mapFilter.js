/**
 * Natural Language Filter Module
 * 
 * Filters maps based on natural language queries with query expansion and fuzzy matching.
 */

import { expandQuery } from './queryExpander.js';

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Edit distance
 */
function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  
  // Create matrix
  const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
  
  // Initialize first row and column
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  
  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  return matrix[len1][len2];
}

/**
 * Check if a value matches a query term using fuzzy matching
 * @param {string} value - Value to check
 * @param {string} term - Search term
 * @param {boolean} useFuzzy - Whether to use fuzzy matching if exact match fails
 * @returns {Object} Match result with {matched: boolean, isFuzzy: boolean, distance: number}
 */
function fuzzyMatch(value, term, useFuzzy = true) {
  if (!value) return { matched: false, isFuzzy: false, distance: Infinity };
  
  const valueStr = String(value).toLowerCase();
  const termStr = term.toLowerCase();
  
  // Try exact match first
  if (valueStr.includes(termStr)) {
    return { matched: true, isFuzzy: false, distance: 0 };
  }
  
  // If exact match fails and fuzzy matching is enabled, try fuzzy match
  if (useFuzzy && termStr.length > 3) {
    // Check if term appears as substring with small edits
    // For performance, only check substrings of similar length
    const maxDistance = termStr.length <= 5 ? 2 : 3;
    
    // Check substrings of the value
    for (let i = 0; i <= valueStr.length - termStr.length + maxDistance; i++) {
      const end = Math.min(i + termStr.length + maxDistance, valueStr.length);
      const substring = valueStr.substring(i, end);
      const distance = levenshteinDistance(termStr, substring);
      
      if (distance <= maxDistance) {
        return { matched: true, isFuzzy: true, distance };
      }
    }
  }
  
  return { matched: false, isFuzzy: false, distance: Infinity };
}

/**
 * Check if a value matches a query term (case-insensitive)
 * @param {string} value - Value to check
 * @param {string} term - Search term
 * @returns {boolean} True if matches
 */
function matchesTerm(value, term) {
  if (!value) return false;
  const valueStr = String(value).toLowerCase();
  const termStr = term.toLowerCase();
  return valueStr.includes(termStr);
}

/**
 * Score a match (higher is better)
 * @param {string} value - Value that matched
 * @param {string} term - Search term
 * @param {boolean} isFuzzy - Whether this is a fuzzy match
 * @param {number} fuzzyDistance - Edit distance for fuzzy matches
 * @param {boolean} isExpandedTerm - Whether this is an expanded synonym (vs original term)
 * @returns {number} Match score
 */
function scoreMatch(value, term, isFuzzy = false, fuzzyDistance = 0, isExpandedTerm = false) {
  if (!value) return 0;
  const valueStr = String(value).toLowerCase();
  const termStr = term.toLowerCase();
  
  let baseScore = 0;
  
  // Calculate base score based on match type
  if (isFuzzy) {
    // Fuzzy match: score based on edit distance
    const maxLength = Math.max(valueStr.length, termStr.length);
    const similarity = 1 - (fuzzyDistance / maxLength);
    baseScore = 30 * similarity; // Fuzzy matches get lower base score
  } else {
    // Exact match scoring
    if (valueStr === termStr) {
      baseScore = 100;
    } else if (valueStr.startsWith(termStr)) {
      baseScore = 80;
    } else if (valueStr.includes(termStr)) {
      baseScore = 50;
    }
  }
  
  // Apply expansion weight: expanded synonyms get 0.8x weight
  if (isExpandedTerm) {
    baseScore *= 0.8;
  }
  
  // Apply fuzzy multiplier: fuzzy matches get 0.7x weight
  if (isFuzzy) {
    baseScore *= 0.7;
  }
  
  return baseScore;
}

/**
 * Filter maps by natural language query with query expansion and fuzzy matching
 * @param {Array<Object>} maps - Array of map entries
 * @param {string} query - Natural language search query
 * @returns {Array<Object>} Filtered and sorted results
 */
export function filterMaps(maps, query) {
  if (!query || !query.trim()) {
    return maps;
  }
  
  // Expand query with synonyms
  const expandedTerms = expandQuery(query);
  
  if (expandedTerms.length === 0) {
    return maps;
  }
  
  // Track original terms for AND logic and expansion weighting
  const originalTerms = query.trim().split(/\s+/).filter(term => term.length > 0).map(t => t.toLowerCase());
  const isOriginalTerm = (term) => originalTerms.includes(term);
  
  // Build expansion map: which expanded terms correspond to which original terms
  // We'll track this by checking if an expanded term came from an original term
  // by seeing if it's in the expansion set for that original term
  const expansionMap = new Map(); // originalTerm -> Set of expanded terms
  for (const origTerm of originalTerms) {
    // Get expansions for this single term
    const termExpansions = expandQuery(origTerm);
    expansionMap.set(origTerm, new Set(termExpansions));
  }
  
  // Score each map
  const scoredMaps = maps.map(map => {
    let totalScore = 0;
    const originalTermMatches = new Set(); // Track which original query terms matched
    
    // Check each expanded term against all fields
    for (const expandedTerm of expandedTerms) {
      const isExpanded = !isOriginalTerm(expandedTerm);
      let termScore = 0;
      let termMatched = false;
      
      // Check name field
      const nameMatch = fuzzyMatch(map.name, expandedTerm, true);
      if (nameMatch.matched) {
        termMatched = true;
        termScore = Math.max(termScore, scoreMatch(
          map.name, 
          expandedTerm, 
          nameMatch.isFuzzy, 
          nameMatch.distance, 
          isExpanded
        ));
      }
      
      // Check URL (with reduced weight)
      const urlMatch = fuzzyMatch(map.url, expandedTerm, true);
      if (urlMatch.matched) {
        termMatched = true;
        const urlScore = scoreMatch(
          map.url, 
          expandedTerm, 
          urlMatch.isFuzzy, 
          urlMatch.distance, 
          isExpanded
        );
        termScore = Math.max(termScore, urlScore * 0.5); // URL matches are less important
      }
      
      // Check all metadata fields (including enriched fields)
      if (map.metadata) {
        for (const [key, value] of Object.entries(map.metadata)) {
          // Skip enriched fields that start with _ for matching (they're used for reasoning, not direct matching)
          if (key.startsWith('_') && key !== '_searchableText') {
            continue;
          }
          
          const fieldMatch = fuzzyMatch(value, expandedTerm, true);
          if (fieldMatch.matched) {
            termMatched = true;
            termScore = Math.max(termScore, scoreMatch(
              value, 
              expandedTerm, 
              fieldMatch.isFuzzy, 
              fieldMatch.distance, 
              isExpanded
            ));
          }
        }
        
        // Also check _searchableText for fuzzy matching fallback
        if (map.metadata._searchableText) {
          const searchableMatch = fuzzyMatch(map.metadata._searchableText, expandedTerm, true);
          if (searchableMatch.matched && termScore === 0) {
            termMatched = true;
            termScore = Math.max(termScore, scoreMatch(
              map.metadata._searchableText, 
              expandedTerm, 
              searchableMatch.isFuzzy, 
              searchableMatch.distance, 
              isExpanded
            ) * 0.6); // Searchable text matches get lower weight
          }
        }
      }
      
      if (termMatched && termScore > 0) {
        totalScore += termScore;
        
        // Track which original terms matched (for AND logic)
        if (!isExpanded) {
          // This is an original term, mark it as matched
          originalTermMatches.add(expandedTerm);
        } else {
          // This is an expanded term, find which original term(s) it came from
          for (const [origTerm, expansions] of expansionMap.entries()) {
            if (expansions.has(expandedTerm)) {
              originalTermMatches.add(origTerm);
            }
          }
        }
      }
    }
    
    // All original terms must match (AND logic)
    // If we matched all original terms (directly or via expansion), include this map
    if (originalTermMatches.size === originalTerms.length) {
      return {
        ...map,
        _score: totalScore,
        _matchCount: originalTermMatches.size
      };
    }
    
    return null;
  }).filter(map => map !== null);
  
  // Sort by score (highest first), then by name
  scoredMaps.sort((a, b) => {
    if (b._score !== a._score) {
      return b._score - a._score;
    }
    return a.name.localeCompare(b.name);
  });
  
  // Remove scoring metadata before returning
  return scoredMaps.map(({ _score, _matchCount, ...map }) => map);
}

