import {displayName} from './core.js';

export const CONNECTION_COLUMNS = ['name','linkedin_url','current_company','titles','past_companies','earliest_listed_full_time_start','connection_date','education','location','headline'];

export function csvText(columns, rows) {
  // Protect spreadsheet formulas, including formulas preceded by whitespace.
  const quote = value => {
    let text = String(value ?? '');
    if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [columns, ...rows.map(row => columns.map(key => row[key]))]
    .map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

export function connectionCSV(capture) {
  if (!capture?.rows?.length) throw new Error('Collect connections or load Connections.csv first.');
  if (capture.phase === 'collecting') throw new Error('Finish or stop collection before exporting.');
  return csvText(CONNECTION_COLUMNS, capture.rows.map(row => ({
    name:displayName(row), linkedin_url:row.linkedinUrl,
    current_company:row.company, titles:row.jobTitle ? JSON.stringify([row.jobTitle]) : '',
    past_companies:'', earliest_listed_full_time_start:'', connection_date:row.connectedOn,
    education:'', location:'', headline:row.headline,
  })));
}

export function connectionSummary(capture) {
  const rows=capture?.rows || [];
  const expected=capture?.expected || null;
  return {source:capture?.source || '',collected_at:capture?.updatedAt || '',
    expected_connections:expected,exported_connections:rows.length,
    unique_profile_urls:new Set(rows.map(r=>r.linkedinUrl).filter(Boolean)).size,
    count_difference:expected===null ? null : expected-rows.length,
    completeness:expected===rows.length ? 'Matches displayed count; fields may still be missing.' : 'Unverified',
    coverage:capture?.reason || '',
    missing_fields:Object.fromEntries(['firstName','linkedinUrl','headline','connectedOn'].map(k=>[k,rows.filter(r=>!r[k]).length])),
    unavailable_from_connections_page:['past_companies','education','location','earliest_listed_full_time_start'],
    note:'Company and title remain in the original headline unless provided separately by the source.'};
}
