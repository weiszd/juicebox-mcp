/**
 * Data Source Configuration Registry
 * 
 * Centralized registry for Hi-C contact map data sources. The catalog URL and
 * columns come from the juicebox-web copy in catalogs.js; the rest is how the
 * search pipeline reads each TSV.
 */

import { encodeContactMapDatasourceConfiguration, fourdnContactMapDatasourceConfiguration } from './catalogs.js';

export const DATA_SOURCES = {
  '4dn': {
    id: '4dn',
    name: '4DN',
    description: '4D Nucleome (4DN) Hi-C contact maps',
    ...fourdnContactMapDatasourceConfiguration,
    parserType: 'tsv',
    urlColumn: 0, // First column is the URL
    nameColumn: 'Dataset' // Use Dataset column as display name
  },
  'encode': {
    id: 'encode',
    name: 'ENCODE',
    description: 'ENCODE Hi-C contact maps',
    ...encodeContactMapDatasourceConfiguration,
    parserType: 'tsv',
    urlColumn: 'HREF', // Column named 'HREF' contains relative path
    urlPrefix: 'https://www.encodeproject.org', // Prefix for ENCODE URLs
    nameColumn: 'Description' // Use Description column as display name
  }
};

/**
 * Get a data source configuration by ID
 * @param {string} sourceId - Source ID ('4dn' or 'encode')
 * @returns {Object|null} Data source configuration or null if not found
 */
export function getDataSource(sourceId) {
  return DATA_SOURCES[sourceId] || null;
}

/**
 * Get all available data source IDs
 * @returns {string[]} Array of source IDs
 */
export function getAllSourceIds() {
  return Object.keys(DATA_SOURCES);
}

/**
 * Check if a source ID is valid
 * @param {string} sourceId - Source ID to check
 * @returns {boolean} True if valid
 */
export function isValidSource(sourceId) {
  return sourceId in DATA_SOURCES;
}

