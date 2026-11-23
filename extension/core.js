export const CRM_URL = 'https://crm.inevitable.tech';
export const API_URLS = [CRM_URL, 'https://twenty-production-9617.up.railway.app'];
export const MAX_CONTACTS = 30000;

export function linkedinUrl(value) {
  try {
    const url = new URL(String(value).trim().replace(/^linkedin\.com\//i, 'https://www.linkedin.com/'));
    if (!['https:', 'http:'].includes(url.protocol) || !/(^|\.)linkedin\.com$/i.test(url.hostname)) return '';
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match) return '';
    const slug = decodeURIComponent(match[1]).normalize('NFC').toLowerCase();
    if (/[\s/?#\\]/.test(slug)) return '';
    return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
  } catch { return ''; }
}

const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
export function contact(input) {
  return {
    firstName: clean(input.firstName, 150), lastName: clean(input.lastName, 150),
    linkedinUrl: linkedinUrl(input.linkedinUrl), email: clean(input.email, 254).toLowerCase(),
    company: clean(input.company), jobTitle: clean(input.jobTitle),
    headline: clean(input.headline), connectedOn: clean(input.connectedOn, 50),
  };
}
export const displayName = row => [row.firstName, row.lastName].filter(Boolean).join(' ');

// Quoted newlines, escaped quotes, CRLF and the notes preceding LinkedIn's header.
export function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === '') quoted = !quoted;
      else field += c;
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field. Use the original Connections.csv file.');
  if (field || row.length) { row.push(field); rows.push(row); }
  const start = rows.findIndex(r => r.map(x => x.replace(/^\uFEFF/, '').trim()).includes('First Name') && r.includes('Last Name'));
  if (start < 0) throw new Error('Choose LinkedIn Connections.csv with First Name and Last Name columns.');
  const headers = rows[start].map(x => x.replace(/^\uFEFF/, '').trim());
  const names = {'First Name':'firstName','Last Name':'lastName','URL':'linkedinUrl','Email Address':'email','Company':'company','Position':'jobTitle','Connected On':'connectedOn'};
  const data = rows.slice(start + 1).filter(r => r.some(x => x.trim())).map(r => contact(Object.fromEntries(headers.map((h, i) => [names[h] || h, r[i] || '']))));
  if (!data.length) throw new Error('This file has no connections.');
  if (data.length > MAX_CONTACTS) throw new Error(`This release supports up to ${MAX_CONTACTS.toLocaleString()} rows per import.`);
  return data;
}

export function personUrls(person) {
  const links = person.linkedinLink || {};
  return [links.primaryLinkUrl, ...(links.secondaryLinks || []).map(l => l.url)].map(linkedinUrl).filter(Boolean);
}
export function personEmails(person) {
  return [person.emails?.primaryEmail, ...(person.emails?.additionalEmails || [])].filter(Boolean).map(x => x.trim().toLowerCase());
}
export function identityIndex(people) {
  const urls = new Map(), emails = new Map();
  const add = (map, key, p) => map.set(key, [...(map.get(key) || []), p]);
  for (const p of people) {
    for (const u of new Set(personUrls(p))) add(urls, u, p);
    for (const e of new Set(personEmails(p))) add(emails, e, p);
  }
  return {urls, emails};
}
export function matchPerson(row, index) {
  const byUrl = index.urls.get(row.linkedinUrl) || [];
  const byEmail = index.emails.get(row.email) || [];
  const all = [...new Map([...byUrl, ...byEmail].map(p => [p.id, p])).values()];
  if (all.length > 1) return {action:'review', reason:'Multiple CRM identities match this contact.'};
  const p = all[0];
  if (p && !byUrl.length && row.linkedinUrl && personUrls(p).length) {
    return {action:'review', reason:'Email matches a CRM person with a different LinkedIn profile.'};
  }
  return p ? {action:'existing', personId:p.id, reason:'Existing CRM contact. Fields stay unchanged.'} : {action:'create', reason:'New contact.'};
}
export function buildPlan(rows, people, companies = []) {
  const index = identityIndex(people), seenUrls = new Set(), seenEmails = new Map();
  const emailProfiles = new Map();
  for (const input of rows) {
    const r = contact(input);
    if (r.email && displayName(r)) emailProfiles.set(r.email, new Set([...(emailProfiles.get(r.email) || []), r.linkedinUrl]));
  }
  const names = new Map();
  for (const c of companies) {
    const name = c.name?.trim().toLowerCase();
    if (name) names.set(name, [...(names.get(name) || []), c.id]);
  }
  return rows.map((input, i) => {
    const row = contact(input);
    let result;
    if (!displayName(row)) result = {action:'review', reason:'Missing name.'};
    else if (!row.linkedinUrl && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) result = {action:'review', reason:'No valid LinkedIn profile or email to identify this person.'};
    else if (row.email && emailProfiles.get(row.email)?.size > 1) result = {action:'review', reason:'Email is shared by different profiles in this import.'};
    else if (row.linkedinUrl && seenUrls.has(row.linkedinUrl)) result = {action:'skip', reason:'Repeated LinkedIn profile in this import.'};
    else if (row.email && seenEmails.has(row.email)) {
      const prior = seenEmails.get(row.email);
      result = prior === row.linkedinUrl ? {action:'skip', reason:'Repeated contact in this import.'} : {action:'review', reason:'Email is shared by different rows in this import.'};
    } else result = matchPerson(row, index);
    if (['create','existing'].includes(result.action)) {
      if (row.linkedinUrl) seenUrls.add(row.linkedinUrl);
      if (row.email) seenEmails.set(row.email, row.linkedinUrl);
    }
    const companyIds = names.get(row.company.toLowerCase()) || [];
    return {...row, ...result, rowId:i, companyId:companyIds.length === 1 ? companyIds[0] : null, companyNote:row.company && companyIds.length !== 1 ? 'Company retained in import report; no unique CRM company match.' : '', status:'pending'};
  });
}
export function personInput(row, id) {
  return {
    id, name:{firstName:row.firstName, lastName:row.lastName},
    ...(row.linkedinUrl ? {linkedinLink:{primaryLinkLabel:'LinkedIn',primaryLinkUrl:row.linkedinUrl}} : {}),
    ...(row.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) ? {emails:{primaryEmail:row.email}} : {}),
    ...(row.jobTitle ? {jobTitle:row.jobTitle} : {}),
    ...(row.companyId ? {companyId:row.companyId} : {}),
  };
}
export async function stableId(key) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('inevitable-linkedin:v1:' + key))).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map(b => b.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export const pairKey = (a,b) => [a,b].sort().join(':');
export function summary(rows) {
  return rows.reduce((s,r) => { s[r.action] = (s[r.action] || 0) + 1; if(r.status === 'done') s.done++; return s; },{create:0,existing:0,review:0,skip:0,done:0});
}
