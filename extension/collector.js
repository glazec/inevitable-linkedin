(() => {
  if (globalThis.inevitableCollectorInstalled) return;
  globalThis.inevitableCollectorInstalled = true;
  let active = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  function rows() {
    // Scope to connection cards. Never collect recommendations or arbitrary profiles.
    const cards = document.querySelectorAll('main .mn-connection-card');
    const result = [];
    for (const card of cards) {
      const link = card.querySelector('a.mn-connection-card__link[href*="/in/"], a[data-test-app-aware-link][href*="/in/"]');
      const name = card.querySelector('.mn-connection-card__name')?.textContent?.trim() || link?.innerText?.trim().split('\n')[0];
      if (!link || !name) continue;
      result.push({firstName:name,lastName:'',linkedinUrl:link.href,headline:card.querySelector('.mn-connection-card__occupation')?.textContent?.trim() || ''});
    }
    // Current cards expose the name through their action menu and show the
    // connection date beside the profile link. Never scan unrelated links.
    for (const button of document.querySelectorAll('button[aria-label^="More actions for "], [role="button"][aria-label^="More actions for "]')) {
      const name = button.getAttribute('aria-label').slice('More actions for '.length).trim();
      if (!name) continue;
      let candidate = null;
      for (let card = button.parentElement; card && card !== document.body; card = card.parentElement) {
        if (card.querySelectorAll('[aria-label^="More actions for "]').length !== 1) break;
        const links = [...card.querySelectorAll('a[href*="/in/"]')].filter(a=>a.textContent.trim());
        const link = links.find(a=>a.textContent.trim().startsWith(name));
        if (!link) continue;
        const date = (card.innerText || card.textContent).match(/Connected on\s+([A-Za-z]+ \d{1,2}, \d{4})/i)
          || [...card.querySelectorAll('*')].filter(el=>el.children.length === 0).map(el=>el.textContent.trim().match(/^Connected on\s+(.+)$/i)).find(Boolean);
        const headline = (link.innerText || link.textContent).trim().slice(name.length).trim();
        candidate = {firstName:name,lastName:'',linkedinUrl:link.href,headline,connectedOn:date?.[1] || ''};
        if (date) break;
      }
      if (candidate) result.push(candidate);
    }
    return result;
  }
  function expectedCount() {
    const headings = [...document.querySelectorAll('h1, h2, [role="heading"], main .mn-connections__header')];
    for (const el of headings) {
      const match = el.textContent.trim().match(/^([\d,]+)\s+connections$/i);
      if (match) return Number(match[1].replaceAll(',',''));
    }
    return null;
  }
  async function collect(id) {
    if (!location.pathname.startsWith('/mynetwork/invite-connect/connections')) return;
    const state = {id,stop:false}; active=state;
    const found = new Map(); let stale=0, rounds=0;
    const report = async (phase,reason) => {
      const response = await chrome.runtime.sendMessage({type:'captureUpdate',captureId:id,rows:[...found.values()],expected:expectedCount(),phase,reason});
      if (!response?.ok) state.stop=true;
    };
    try {
      while (!state.stop && rounds++ < 4000) {
        if (!location.pathname.startsWith('/mynetwork/invite-connect/connections')) {await report('blocked','Page changed. Collection is incomplete.');return;}
        const previous=found.size;
        for (const row of rows()) {
          const url = new URL(row.linkedinUrl); url.search='';url.hash='';
          row.linkedinUrl=url.href.replace(/\/$/,'');
          const previousRow=found.get(row.linkedinUrl) || {};
          found.set(row.linkedinUrl,{...row,...previousRow,...Object.fromEntries(Object.entries(row).filter(([,value])=>value !== ''))});
        }
        stale = previous === found.size ? stale+1 : 0;
        const expected=expectedCount();
        if (found.size >= 30000) {await report('stopped','Reached the 30,000 contact limit. Review coverage before importing.');return;}
        if (expected && found.size === expected) {await report('ready',`Captured all ${expected.toLocaleString()} connections shown in the page count.`);return;}
        if (stale >= 10) {await report('stopped',found.size ? 'No more connection cards loaded. Completeness is unverified; compare the count or use your LinkedIn CSV export.' : 'No supported connection cards found. Sign in and use the connections page, or import Connections.csv.');return;}
        await report('collecting',`Collected ${found.size.toLocaleString()}${expected ? ' of '+expected.toLocaleString() : ''}. Keep this LinkedIn tab open.`);
        const cards = document.querySelectorAll('main .mn-connection-card, [aria-label^="More actions for "]');
        const last=cards[cards.length-1];
        if (last) last.scrollIntoView({block:'end'});
        window.scrollTo(0,document.body.scrollHeight);
        const more=[...document.querySelectorAll('main button')].find(b => /^show more results$/i.test(b.innerText.trim()) && !b.disabled);
        if (more) more.click();
        await sleep(1800);
      }
      await report('stopped','Collection stopped. Completeness is unverified.');
    } catch { try { await report('blocked','Collection interrupted. Saved contacts remain available.'); } catch {} }
    finally { if(active===state) active=null; }
  }
  chrome.runtime.onMessage.addListener((message,_sender,respond) => {
    if (message.type === 'startCapture') {
      if (!location.pathname.startsWith('/mynetwork/invite-connect/connections')) {
        respond({ok:false,error:'Open your LinkedIn connections page first.'});return;
      }
      if (active) active.stop=true;
      void collect(message.captureId); respond({ok:true});
    } else if (message.type === 'stopCapture' && active?.id === message.captureId) {active.stop=true;respond({ok:true});}
  });
})();
