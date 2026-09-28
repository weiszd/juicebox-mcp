/**
 * Data Parser Module
 * 
 * Handles fetching and parsing TSV files from data sources.
 */

import { getDataSource } from './dataSourceConfigs.js';
import { enrichMaps } from './metadataEnricher.js';

// Cache for parsed data (cleared on server restart)
const dataCache = new Map();

/**
 * Fetch text content from a URL
 * @param {string} url - URL to fetch
 * @returns {Promise<string>} Text content
 */
async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Juicebox-MCP/1.0)'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return await response.text();
}

/**
 * Parse TSV data into structured objects
 * @param {string} tsvData - TSV file content
 * @param {Object} config - Data source configuration
 * @returns {Array<Object>} Array of parsed map entries
 */
function parseTSV(tsvData, config) {
  const lines = tsvData.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  if (lines.length === 0) {
    return [];
  }

  // Find header line (skip comment lines)
  let headerLineIndex = 0;
  while (headerLineIndex < lines.length && lines[headerLineIndex].startsWith('#')) {
    headerLineIndex++;
  }
  
  if (headerLineIndex >= lines.length) {
    return [];
  }
  
  const headerLine = lines[headerLineIndex];
  const headers = headerLine.split('\t');
  
  // Find URL column index
  let urlColumnIndex = -1;
  if (typeof config.urlColumn === 'number') {
    urlColumnIndex = config.urlColumn;
  } else if (typeof config.urlColumn === 'string') {
    urlColumnIndex = headers.indexOf(config.urlColumn);
    if (urlColumnIndex === -1) {
      throw new Error(`URL column "${config.urlColumn}" not found in headers: ${headers.join(', ')}`);
    }
  }

  // Find name column index
  const nameColumnIndex = headers.indexOf(config.nameColumn);
  
  // Parse data rows (start after header line)
  const results = [];
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment lines
    if (line.startsWith('#')) continue;
    
    const values = line.split('\t');
    
    // Skip rows that don't have enough columns
    if (values.length <= urlColumnIndex) continue;
    
    // Extract URL
    let url = values[urlColumnIndex]?.trim();
    if (!url) continue; // Skip rows without URL
    
    // Apply URL prefix if needed (for ENCODE)
    if (config.urlPrefix && !url.startsWith('http')) {
      url = config.urlPrefix + url;
    }
    
    // Extract name
    const name = nameColumnIndex >= 0 && values[nameColumnIndex] 
      ? values[nameColumnIndex].trim() 
      : url.split('/').pop() || 'Unnamed';
    
    // Build metadata object
    const metadata = {};
    config.columns.forEach((columnName, idx) => {
      const valueIndex = headers.indexOf(columnName);
      if (valueIndex >= 0 && valueIndex < values.length) {
        metadata[columnName] = values[valueIndex]?.trim() || '';
      } else {
        metadata[columnName] = '';
      }
    });
    
    results.push({
      url,
      name,
      source: config.id,
      metadata
    });
  }
  
  // Enrich maps with computed metadata fields
  return enrichMaps(results);
}

/**
 * Parse data from a data source
 * @param {string} sourceId - Source ID ('4dn' or 'encode')
 * @param {boolean} useCache - Whether to use cached data (default: true)
 * @returns {Promise<Array<Object>>} Array of map entries
 */
export async function parseDataSource(sourceId, useCache = true) {
  // Check cache first
  if (useCache && dataCache.has(sourceId)) {
    return dataCache.get(sourceId);
  }
  
  const config = getDataSource(sourceId);
  if (!config) {
    throw new Error(`Unknown data source: ${sourceId}`);
  }
  
  if (config.parserType !== 'tsv') {
    throw new Error(`Unsupported parser type: ${config.parserType}`);
  }
  
  try {
    // Fetch TSV data
    const tsvData = await fetchText(config.url);
    
    // Parse TSV
    const results = parseTSV(tsvData, config);
    
    // Cache results
    if (useCache) {
      dataCache.set(sourceId, results);
    }
    
    return results;
  } catch (error) {
    throw new Error(`Failed to parse data source ${sourceId}: ${error.message}`);
  }
}

/**
 * Clear the data cache for a specific source or all sources
 * @param {string|null} sourceId - Source ID to clear, or null to clear all
 */
export function clearCache(sourceId = null) {
  if (sourceId) {
    dataCache.delete(sourceId);
  } else {
    dataCache.clear();
  }
}

