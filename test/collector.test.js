import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const source=await readFile(new URL('../extension/collector.js',import.meta.url),'utf8');

test('rejects starting collection after a LinkedIn login redirect',()=>{
  const dom=new JSDOM('<main>Sign in</main>',{url:'https://www.linkedin.com/uas/login',runScripts:'outside-only'});
  let listener,response;
  dom.window.chrome={runtime:{onMessage:{addListener(fn){listener=fn;}}}};
  dom.window.eval(source);
  listener({type:'startCapture',captureId:'test'},{},value=>{response=value;});
  assert.equal(response.ok,false);
  dom.window.close();
});

async function collect(html,onUpdate=()=>{}) {
  const dom=new JSDOM(html,{url:'https://www.linkedin.com/mynetwork/invite-connect/connections/',runScripts:'outside-only'});
  const updates=[];let listener;
  dom.window.chrome={runtime:{onMessage:{addListener(fn){listener=fn;}},async sendMessage(m){updates.push(m);onUpdate(dom,m);return {ok:true};}}};
  dom.window.scrollTo=()=>{};dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
  dom.window.setTimeout=fn=>setTimeout(fn,0);
  dom.window.eval(source);
  listener({type:'startCapture',captureId:'test'}, {},()=>{});
  for(let i=0;i<100;i++){
    if(updates.at(-1)?.phase!=='collecting'&&updates.length)break;
    await new Promise(r=>setTimeout(r,2));
  }
  dom.window.close();return updates;
}
test('captures connection cards and excludes recommendations elsewhere on the page',async()=>{
  const updates=await collect('<main><h1>1 connections</h1><li class="mn-connection-card"><a class="mn-connection-card__link" href="/in/alex"><span class="mn-connection-card__name">Alex Chen</span></a><span class="mn-connection-card__occupation">Founder</span></li><section><a href="/in/recommendation">Recommendation</a></section></main>');
  assert.equal(updates.at(-1).phase,'ready');assert.equal(updates.at(-1).rows.length,1);assert.equal(updates.at(-1).rows[0].headline,'Founder');
});
test('unknown markup never claims all connections were captured',async()=>{
  const updates=await collect('<main><h1>500 connections</h1><li><a href="/in/recommendation">Not a supported card</a></li></main>');
  assert.equal(updates.at(-1).phase,'stopped');assert.equal(updates.at(-1).rows.length,0);
});

test('maps the observed connection date and excludes links outside modern cards', async()=>{
  const updates = await collect('<section><h2>1 connections</h2><article><a href="/in/alex">Alex Example<br>Founder</a><span>Connected on November 4, 2026</span><button aria-label="More actions for Alex Example"></button></article><aside><a href="/in/other">Another person</a></aside></section>');
  assert.equal(updates.at(-1).phase,'ready');
  assert.deepEqual(JSON.parse(JSON.stringify(updates.at(-1).rows)),[{firstName:'Alex Example',lastName:'',linkedinUrl:'https://www.linkedin.com/in/alex',headline:'Founder',connectedOn:'November 4, 2026'}]);
});

test('retains a connection even when its date is absent or unrecognized',async()=>{
  for (const date of ['', 'Connected on yesterday']) {
    const updates=await collect(`<section><h2>1 connections</h2><article><a href="/in/alex">Alex Example<br>Founder</a><span>${date}</span><button aria-label="More actions for Alex Example"></button></article></section>`);
    assert.equal(updates.at(-1).rows.length,1);
    assert.equal(updates.at(-1).rows[0].connectedOn,date ? 'yesterday' : '');
  }
});


test('later incomplete rendering never erases previously captured contact fields',async()=>{
  const html='<section><h2>2 connections</h2><article><a href="/in/alex">Alex Example<br>Founder</a><span id="date">Connected on November 4, 2026</span><button aria-label="More actions for Alex Example"></button></article></section>';
  const updates=await collect(html,(dom)=>{dom.window.document.getElementById('date').textContent='';});
  assert.equal(updates.at(-1).rows[0].connectedOn,'November 4, 2026');
  assert.equal(updates.at(-1).phase,'stopped');
});
