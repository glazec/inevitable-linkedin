import {connectionCSV, connectionSummary, csvText} from './export.js';
import { parseCSV, summary, displayName, CRM_URL } from './core.js';
const $ = id => document.getElementById(id);
let state = {}, page = 0, pending = false;
const isExtension = !!globalThis.chrome?.runtime?.id;

async function call(type,data={}) {
  if (!isExtension) throw new Error('Load this folder as a Chrome extension to connect your accounts. This is a visual preview.');
  const result = await chrome.runtime.sendMessage({type,...data});
  if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Reopen it and try again.');
  return result.data;
}
function notice(text,success=false) { $('notice').textContent=text; $('notice').className=success?'success':'';$('notice').hidden=!text; }
async function action(work) {
  if(pending)return;pending=true;notice('');render();
  try { await work(); } catch(error) {notice(error.message);}
  finally {pending=false;await refresh();}
}
async function refresh() {
  if(isExtension) {
    try {state=await call('state');}catch(error){notice(error.message);}
  }
  render();
}
function render() {
  const {capture,job}=state;
  const collecting=capture?.phase==='collecting', importing=job?.phase==='running';
  const locked=pending||state.busy||importing;
  $('captured').textContent=(capture?.rows.length || 0).toLocaleString();
  $('coverage').textContent=capture?.reason || 'Nothing collected yet';
  $('connectionState').textContent=state.hasToken?'API key available for this session':'API key needed';
  $('stopCapture').hidden=!collecting;
  $('collect').disabled=locked||collecting;
  $('csv').disabled=locked||collecting;
  $('exportConnections').disabled=collecting||!capture?.rows.length;
  $('exportSummary').disabled=collecting||!capture?.rows.length;
  $('preview').disabled=locked||collecting||!capture?.rows.length||!state.hasToken;
  $('owner').disabled=locked;
  $('loadOwners').disabled=locked||!state.hasToken;
  $('saveSettings').disabled=locked;
  $('disconnect').disabled=locked;
  $('clear').disabled=locked||collecting;
  $('progress').textContent=state.progress || (pending?'Working…':'');
  $('plan').hidden=!job;$('empty').hidden=!!job;
  $('phase').textContent=job?{preview:'PREVIEW READY',running:'IMPORT IN PROGRESS',paused:'IMPORT PAUSED',complete:'IMPORT FINISHED'}[job.phase]:'READY WHEN YOU ARE';
  if (!job) return;
  const counts=summary(job.rows);
  $('newCount').textContent=counts.create.toLocaleString();$('existingCount').textContent=counts.existing.toLocaleString();$('reviewCount').textContent=counts.review.toLocaleString();$('doneCount').textContent=counts.done.toLocaleString();
  $('jobError').textContent=job.error || '';$('jobError').hidden=!job.error;
  $('start').hidden=job.phase!=='preview';$('start').disabled=locked||!state.hasToken||!(counts.create+counts.existing);
  $('pause').hidden=!importing;$('resume').hidden=job.phase!=='paused';$('resume').disabled=locked||!state.hasToken;
  $('importTitle').textContent=importing?`${counts.done.toLocaleString()} of ${(counts.create+counts.existing).toLocaleString()} contacts processed.`:job.phase==='complete'?'Import finished.':job.phase==='paused'?'Progress saved. Resume when ready.':'Review your preview before importing.';
  $('importDetail').textContent=`${counts.review} need review. ${counts.skip} skipped. ${job.ownerId?'Relationship ownership will be saved.':'Contacts only; relationship ownership is not selected.'}`;
  renderRows();
}
function filteredRows() {
  const term=$('search').value.trim().toLowerCase(),filter=$('filter').value;
  return (state.job?.rows || []).filter(r => (filter==='all'||r.action===filter) && [displayName(r),r.company,r.jobTitle,r.headline,r.email,r.linkedinUrl].join(' ').toLowerCase().includes(term));
}
function renderRows() {
  const rows=filteredRows();page=Math.min(page,Math.max(0,Math.ceil(rows.length/25)-1));
  const body=$('rows');body.replaceChildren();
  for (const row of rows.slice(page*25,page*25+25)) {
    const tr=document.createElement('tr');
    const name=document.createElement('td');
    const link=document.createElement(row.linkedinUrl?'a':'strong');link.textContent=displayName(row)||'Unnamed contact';
    if(row.linkedinUrl){link.href=row.linkedinUrl;link.target='_blank';link.rel='noreferrer';}
    name.append(link); const email=document.createElement('small');email.textContent=row.email || row.linkedinUrl?.replace('https://www.','') || '';name.append(email);
    const role=document.createElement('td');role.textContent=row.company||row.headline||'Not provided';
    const title=document.createElement('small');title.textContent=row.jobTitle||row.companyNote||'';role.append(title);
    const actionCell=document.createElement('td'),pill=document.createElement('span');pill.className='pill '+row.action;pill.textContent={create:'New person',existing:'Already in CRM',review:'Needs review',skip:'Skip'}[row.action];actionCell.append(pill);
    const reason=document.createElement('small');reason.textContent=row.reason;actionCell.append(reason);
    const status=document.createElement('td');status.textContent=row.status==='done'?'Imported':row.action==='review'||row.action==='skip'?'Excluded':'Pending';
    if(row.status==='done'&&row.personId){const crm=document.createElement('a');crm.href=`${CRM_URL}/object/people/${encodeURIComponent(row.personId)}`;crm.target='_blank';crm.rel='noreferrer';crm.textContent='Open ↗';status.append(document.createElement('br'),crm);}
    tr.append(name,role,actionCell,status);body.append(tr);
  }
  $('pageInfo').textContent=rows.length?`${page*25+1} to ${Math.min(page*25+25,rows.length)} of ${rows.length.toLocaleString()} connections`:'No matching connections';
  $('previous').disabled=page===0;$('next').disabled=(page+1)*25>=rows.length;
}
$('settingsToggle').onclick=() => {$('settings').hidden=!$('settings').hidden;};
$('saveSettings').onclick=() => action(async()=>{await call('settings',{apiUrl:$('apiUrl').value,token:$('token').value});$('token').value='';notice('CRM connected. Collect your connections to continue.',true);});
$('disconnect').onclick=() => action(async()=>{await call('disconnect');$('token').value='';notice('API key removed from this browser session.',true);});
function downloadCSV(csv,filename,type='text/csv;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([csv],{type}));
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('exportSummary').onclick=()=>action(async()=>downloadCSV(JSON.stringify(connectionSummary(state.capture),null,2),'connections-summary.json','application/json'));
$('exportConnections').onclick=()=>action(async()=>downloadCSV(connectionCSV(state.capture),'connections.csv'));
$('collect').onclick=() => action(()=>call('collect'));
$('stopCapture').onclick=() => action(()=>call('stopCapture'));
$('csv').onchange=event => action(async()=>{const file=event.target.files[0];if(!file)return;if(file.size>20*1024*1024)throw new Error('Choose a CSV smaller than 20 MB.');const rows=parseCSV(await file.text());await call('loadCSV',{rows});page=0;event.target.value='';});
$('loadOwners').onclick=() => action(async()=>{const owners=await call('owners');const select=$('owner');select.replaceChildren(new Option('Contacts only',''));for(const p of owners)select.add(new Option([p.name?.firstName,p.name?.lastName].filter(Boolean).join(' '),p.id));notice(owners.length?'Choose yourself as the connection owner.':'No people marked as team members were found in CRM.',true);});
$('preview').onclick=() => action(async()=>{await call('preview',{ownerId:$('owner').value});page=0;});
$('start').onclick=() => action(()=>call('start'));
$('pause').onclick=() => action(async()=>{await call('pause');notice('Import will pause after the current contact is saved.',true);});
$('resume').onclick=() => action(()=>call('resume'));
$('clear').onclick=() => action(()=>call('clear'));
$('search').oninput=$('filter').onchange=()=>{page=0;renderRows();};
$('previous').onclick=()=>{page--;renderRows();};$('next').onclick=()=>{page++;renderRows();};
$('export').onclick=()=>{
  const columns=['firstName','lastName','linkedinUrl','email','company','jobTitle','headline','connectedOn','action','reason','companyNote','status','personId','relationshipId'];
  downloadCSV(csvText(columns,state.job.rows),'connections-report.csv');
};
await refresh();
if(state.settings?.apiUrl)$('apiUrl').value=state.settings.apiUrl;
// CSV collection and export do not require CRM credentials.
if(isExtension)chrome.storage.onChanged.addListener(()=>void refresh());
else notice('Visual preview. Load the extension in Chrome to collect and import contacts.',true);
