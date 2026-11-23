import { API_URLS, MAX_CONTACTS, contact, buildPlan, summary } from './core.js';
import { CRM, PERSON_FIELDS } from './crm.js';

const ready = Promise.all([
  chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
  chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}),
]);
let busy = false, running = false, pauseRequested = false;
const get = async key => (await chrome.storage.local.get(key))[key];
const put = (key, value) => chrome.storage.local.set({[key]:value});
const rowKey = (job,row) => `result:${job.id}:${row.rowId}`;
async function readJob() {
  const job = await get('job');
  if (!job) return job;
  const results = await chrome.storage.local.get(job.rows.map(row => rowKey(job,row)));
  job.rows = job.rows.map(row => ({...row,...results[rowKey(job,row)]}));
  return job;
}
async function clearJob() {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter(key => key === 'job' || key.startsWith('result:'));
  await chrome.storage.local.remove(keys);
}
const saveRow = (job,row) => put(rowKey(job,row),{personId:row.personId,status:row.status,relationshipId:row.relationshipId || null});
async function client() {
  const settings = await get('settings');
  const {token} = await chrome.storage.session.get('token');
  return new CRM({apiUrl:settings?.apiUrl || API_URLS[1],token});
}
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url === url);
  if (existing) await chrome.tabs.update(existing.id,{active:true});
  else await chrome.tabs.create({url});
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'import') void run(); });
chrome.tabs.onRemoved.addListener(async tabId => {
  const capture = await get('capture');
  if (capture?.phase === 'collecting' && capture.tabId === tabId) {
    capture.phase='stopped';capture.reason='LinkedIn tab closed. Saved contacts remain available; coverage is unverified.';await put('capture',capture);
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await ready;
  const job = await get('job');
  if (job?.phase === 'running') { job.phase = 'paused'; job.error = 'Browser restarted. Add your API key again, then resume.'; await put('job',job); }
});

async function run() {
  if (running || busy) return;
  running = true; pauseRequested = false;
  let job;
  try {
    await ready;
    job = await readJob();
    if (job?.phase !== 'running') return;
    const crm = await client();
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (pauseRequested) { job.phase = 'paused'; break; }
      const row = job.rows.find(r => r.status === 'pending' && ['create','existing'].includes(r.action));
      if (!row) { job.phase = 'complete'; job.finishedAt = new Date().toISOString(); break; }
      // Every mutation uses stable IDs. A worker termination before this checkpoint
      // is recovered by checking the same IDs on resume, including relationship rows.
      const personId = await crm.ensurePerson(row);
      row.personId = personId;
      await saveRow(job,row);
      row.relationshipId = await crm.ensureRelationship(job.ownerId,personId,row,job.collectedAt);
      row.status = 'done'; row.error = ''; job.error = ''; job.updatedAt = new Date().toISOString();
      await saveRow(job,row);
    }
    await put('job',job);
    if (job.phase !== 'running') await chrome.alarms.clear('import');
    else setTimeout(() => void run(), 500);
  } catch (error) {
    if (job) { job.phase = 'paused'; job.error = error.message; await put('job',job); }
    await chrome.alarms.clear('import');
  } finally { running = false; }
}

async function waitForTab(id) {
  for (let i = 0; i < 40; i++) {
    const tab = await chrome.tabs.get(id);
    if (tab.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw new Error('LinkedIn did not finish loading. Open your connections page and try again.');
}

async function dispatch(message, sender) {
  await ready;
  if (message.type === 'captureUpdate') {
    const capture = await get('capture');
    if (!capture || capture.phase !== 'collecting' || sender.tab?.id !== capture.tabId || message.captureId !== capture.id || !sender.url?.startsWith('https://www.linkedin.com/mynetwork/invite-connect/connections')) throw new Error('Unexpected collection message.');
    if (!Array.isArray(message.rows) || message.rows.length > MAX_CONTACTS) throw new Error('Invalid collection.');
    capture.rows = message.rows.map(contact).filter(r => r.linkedinUrl);
    capture.expected = Number.isSafeInteger(message.expected) && message.expected > 0 ? message.expected : null;
    capture.phase = ['collecting','ready','stopped','blocked'].includes(message.phase) ? message.phase : 'stopped';
    capture.reason = String(message.reason || '').slice(0,500);
    capture.updatedAt = new Date().toISOString();
    await put('capture',capture);
    return {count:capture.rows.length};
  }
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('app.html')) throw new Error('Open the extension to perform this action.');
  if (message.type === 'state') {
    const state = await chrome.storage.local.get(['settings','capture','job','progress']);
    state.job = await readJob();
    const {token} = await chrome.storage.session.get('token');
    return {...state,hasToken:!!token,busy};
  }
  if (message.type === 'pause') {
    pauseRequested = true;
    if (!running) { const job = await get('job'); if (job?.phase === 'running') {job.phase='paused';await put('job',job);} await chrome.alarms.clear('import'); }
    return {};
  }
  if (message.type === 'stopCapture') {
    const capture = await get('capture');
    if (capture?.phase === 'collecting') {
      try { await chrome.tabs.sendMessage(capture.tabId,{type:'stopCapture',captureId:capture.id}); } catch {}
      capture.phase = 'stopped'; capture.reason = 'Collection stopped. Completeness is unverified.';
      await put('capture',capture);
    }
    return {};
  }
  if (busy || running || (await get('job'))?.phase === 'running') throw new Error('Pause the current import before changing its setup.');
  busy = true;
  try {
    switch (message.type) {
      case 'settings': {
        if (!API_URLS.includes(message.apiUrl)) throw new Error('Unsupported CRM endpoint.');
        const token = String(message.token || '').trim();
        if (token) await chrome.storage.session.set({token});
        await put('settings',{apiUrl:message.apiUrl});
        const crm = await client();
        await crm.query('{ people(first:1) { edges { node { id } } } }');
        return {connected:true};
      }
      case 'disconnect': {
        await chrome.storage.session.remove('token'); return {};
      }
      case 'owners': {
        return (await (await client()).all('people','id name { firstName lastName } linkedinLink { primaryLinkUrl }','{isIosgTeam:{eq:true}}'));
      }
      case 'loadCSV': {
        if (!Array.isArray(message.rows) || !message.rows.length || message.rows.length > MAX_CONTACTS) throw new Error('Invalid CSV row count.');
        if ((await get('capture'))?.phase === 'collecting') throw new Error('Stop browser collection before loading a file.');
        await put('capture',{id:crypto.randomUUID(),source:'csv',phase:'ready',rows:message.rows.map(contact),expected:null,updatedAt:new Date().toISOString(),reason:'All rows in the selected file loaded. Coverage depends on your LinkedIn export.'});
        await clearJob(); return {};
      }
      case 'collect': {
        if ((await get('capture'))?.phase === 'collecting') throw new Error('A collection is already running. Stop it first.');
        const tabs = await chrome.tabs.query({url:'https://www.linkedin.com/mynetwork/invite-connect/connections*'});
        const tab = tabs[0] || await chrome.tabs.create({url:'https://www.linkedin.com/mynetwork/invite-connect/connections/',active:true});
        if (tabs[0]) await chrome.tabs.update(tab.id,{active:true});
        const loaded = await waitForTab(tab.id);
        if (!loaded.url?.startsWith('https://www.linkedin.com/mynetwork/invite-connect/connections')) {
          throw new Error('Sign in to LinkedIn, then collect again from your connections page.');
        }
        const id = crypto.randomUUID();
        await clearJob();
        await put('capture',{id,tabId:tab.id,source:'browser',phase:'collecting',rows:[],expected:null,updatedAt:new Date().toISOString(),reason:'Reading your connections page. Keep it open.'});
        try {
          await chrome.scripting.executeScript({target:{tabId:tab.id},files:['collector.js']});
          const result = await chrome.tabs.sendMessage(tab.id,{type:'startCapture',captureId:id});
          if (!result?.ok) throw new Error('LinkedIn connections page is unavailable.');
        } catch {
          const capture = await get('capture'); capture.phase='blocked';capture.reason='Sign in to LinkedIn and open your connections page, then collect again.';await put('capture',capture);
        }
        return {};
      }
      case 'preview': {
        const capture = await get('capture');
        if (!capture?.rows.length || capture.phase === 'collecting') throw new Error('Finish or stop collecting before preparing the preview.');
        const crm = await client();
        await put('progress','Checking CRM contacts…');
        const people = await crm.all('people',PERSON_FIELDS,null,n => put('progress',`Checked ${n.toLocaleString()} CRM contacts…`));
        const ownerId = String(message.ownerId || '');
        if (ownerId && !people.some(p => p.id === ownerId)) throw new Error('Choose an existing CRM person as the connection owner.');
        const companies = capture.rows.some(r => r.company) ? await crm.all('companies','id name') : [];
        const rows = buildPlan(capture.rows,people,companies);
        if (ownerId) for (const row of rows) if (row.personId === ownerId) {row.action='skip';row.reason='Connection owner is the same person.';}
        const settings = await get('settings');
        const job = {id:crypto.randomUUID(),phase:'preview',rows,ownerId,apiUrl:settings.apiUrl,collectedAt:capture.updatedAt,preparedAt:new Date().toISOString(),error:''};
        await clearJob(); await put('job',job); return summary(rows);
      }
      case 'start': case 'resume': {
        const job = await readJob();
        if (!job || !['preview','paused'].includes(job.phase)) throw new Error('Prepare an import preview first.');
        if (message.type === 'resume' && job.phase !== 'paused') throw new Error('Review the preview and use Import to CRM first.');
        if (message.type === 'start' && Date.now() - Date.parse(job.preparedAt) > 10 * 60 * 1000) throw new Error('Preview is over ten minutes old. Prepare it again before importing.');
        const settings = await get('settings');
        if (job.apiUrl !== settings?.apiUrl) throw new Error('CRM endpoint changed. Prepare a new preview.');
        await client();
        job.phase='running';job.error='';await put('job',job);
        await chrome.alarms.create('import',{periodInMinutes:0.5});
        setTimeout(() => void run(),100); return {};
      }
      case 'clear': {
        if ((await get('capture'))?.phase === 'collecting') throw new Error('Stop collection first.');
        await clearJob(); await chrome.storage.local.remove(['capture','progress']);return {};
      }
      default: throw new Error('Unknown action.');
    }
  } finally { busy=false; await chrome.storage.local.remove('progress'); }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  dispatch(message,sender).then(data => respond({ok:true,data})).catch(error => respond({ok:false,error:error.message}));
  return true;
});
