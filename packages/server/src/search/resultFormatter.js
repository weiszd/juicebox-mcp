/**
 * Result Formatter Module
 * 
 * Formats search results for display in Claude Desktop.
 */

/**
 * Truncate a string to a maximum length
 * @param {string} str - String to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated string
 */
function truncate(str, maxLength = 40) {
  if (!str) return '';
  const strStr = String(str);
  if (strStr.length <= maxLength) return strStr;
  return strStr.substring(0, maxLength - 3) + '...';
}

/**
 * Format search results as a readable table
 * @param {Array<Object>} maps - Array of map entries
 * @param {string} query - Search query used
 * @param {string} source - Source ID or 'all'
 * @returns {string} Formatted table text
 */
export function formatSearchResults(maps, query, source = 'all') {
  if (maps.length === 0) {
    return `No maps found matching "${query}"${source !== 'all' ? ` in ${source}` : ''}.`;
  }
  
  const sourceName = source !== 'all' ? source.toUpperCase() : 'all sources';
  let output = `Found ${maps.length} map${maps.length === 1 ? '' : 's'} matching "${query}"${source !== 'all' ? ` in ${sourceName}` : ''}:\n\n`;
  
  // Determine which columns to display based on available data
  const allColumns = new Set();
  maps.forEach(map => {
    if (map.metadata) {
      Object.keys(map.metadata).forEach(key => allColumns.add(key));
    }
  });
  
  // Priority columns to show (in order)
  const priorityColumns = ['Assembly', 'Biosource', 'Biosample', 'Description', 'Dataset', 'Lab', 'Experiment'];
  const displayColumns = priorityColumns.filter(col => allColumns.has(col));
  
  // Build table header
  const header = ['#', 'Source', 'Name'];
  displayColumns.forEach(col => header.push(col));
  
  // Calculate column widths
  const widths = header.map(() => 0);
  maps.forEach((map, index) => {
    widths[0] = Math.max(widths[0], String(index + 1).length);
    widths[1] = Math.max(widths[1], map.source ? map.source.length : 0);
    widths[2] = Math.max(widths[2], map.name ? map.name.length : 0);
    displayColumns.forEach((col, colIdx) => {
      const value = map.metadata?.[col] || '';
      widths[colIdx + 3] = Math.max(widths[colIdx + 3], String(value).length);
    });
  });
  
  // Cap column widths
  widths.forEach((w, i) => {
    widths[i] = Math.min(w, i === 2 ? 50 : 20); // Name can be longer
  });
  
  // Format header row
  const headerRow = header.map((col, i) => {
    const width = widths[i];
    return truncate(col, width).padEnd(width);
  }).join(' | ');
  
  output += headerRow + '\n';
  output += '-'.repeat(headerRow.length) + '\n';
  
  // Format data rows
  maps.forEach((map, index) => {
    const row = [
      String(index + 1).padEnd(widths[0]),
      truncate(map.source || '', widths[1]).padEnd(widths[1]),
      truncate(map.name || '', widths[2]).padEnd(widths[2])
    ];
    
    displayColumns.forEach((col, colIdx) => {
      const value = map.metadata?.[col] || '';
      row.push(truncate(value, widths[colIdx + 3]).padEnd(widths[colIdx + 3]));
    });
    
    output += row.join(' | ') + '\n';
  });
  
  return output;
}

/**
 * Format results as structured JSON for Claude to parse
 * @param {Array<Object>} maps - Array of map entries
 * @returns {string} JSON string
 */
export function formatSearchResultsJSON(maps) {
  return JSON.stringify(maps, null, 2);
}

