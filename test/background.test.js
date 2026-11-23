import test from 'node:test';
import assert from 'node:assert/strict';
import {API_URLS} from '../extension/core.js';

test('background worker enforces preview, restricts senders, checkpoints and resumes an uncertain write',async()=>{
  const originalTimeout=globalThis.setTimeout,originalFetch=globalThis.fetch;
  globalThis.setTimeout=(fn,ms,...args)=>originalTimeout(fn,Math.min(ms,1),...args);
  const local={},session={},listeners={};let creates=0,loseResponse=true;
  const records=new Map();
  const area=data=>({async setAccessLevel(){},async get(keys){const list=keys===null?Object.keys(data):Array.isArray(keys)?keys:[keys];return structuredClone(Object.fromEntries(list.filter(k=>k in data).map(k=>[k,data[k]])));},async set(values){Object.assign(data,structuredClone(values));},async remove(keys){for(const key of Array.isArray(keys)?keys:[keys])delete data[key];}});
  const event=name=>({addListener(fn){listeners[name]=fn;}});
  globalThis.chrome={
    storage:{local:area(local),session:area(session)},
    runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:event('message'),onStartup:event('startup')},
    action:{onClicked:event('click')},alarms:{onAlarm:event('alarm'),async create(){},async clear(){}},
    tabs:{
      onRemoved:event('removed'),
      async query(){return [];},
      async create(){return {id:9};},
      async get(){return {id:9,status:'complete',url:'https://www.linkedin.com/uas/login'};},
    },
  };
  globalThis.fetch=async(_url,init)=>{
    const {query,variables}=JSON.parse(init.body);
    if(query.startsWith('mutation')){
      records.set(variables.data.id,variables.data);creates++;
      if(loseResponse){loseResponse=false;throw new Error('lost response');}
      return {ok:true,json:async()=>({data:{createPerson:{id:variables.data.id}}})};
    }
    const id=query.match(/filter:\{id:\{eq:"([^"]+)"/)?.[1];
    const found=id?[records.get(id)].filter(Boolean):query.includes('filter:')?[]:[...records.values()];
    return {ok:true,json:async()=>({data:{people:{edges:found.map(node=>({node})),pageInfo:{hasNextPage:false,endCursor:null}}}})};
  };
  const sender={id:'test',url:'chrome-extension://test/app.html'};
  const call=(type,data={},from=sender)=>new Promise(resolve=>listeners.message({type,...data},from,resolve));
  const waitFor=async phase=>{
    for(let i=0;i<300;i++){const r=await call('state');if(r.data.job?.phase===phase)return r.data;await new Promise(r=>originalTimeout(r,5));}
    throw new Error('Worker did not reach '+phase);
  };
  try {
    await import('../extension/background.js?test');
    assert.equal((await call('start')).ok,false);
    assert.equal((await call('settings',{apiUrl:API_URLS[1],token:'secret'},{id:'test',url:'https://www.linkedin.com/',tab:{id:9}})).ok,false);
    assert.equal((await call('settings',{apiUrl:API_URLS[1],token:'secret'})).ok,true);
    await call('loadCSV',{rows:[{firstName:'Alex',lastName:'Chen',linkedinUrl:'https://www.linkedin.com/in/alex'}]});
    const redirected=await call('collect');
    assert.equal(redirected.ok,false);
    assert.match(redirected.error,/Sign in to LinkedIn/);
    assert.equal((await call('state')).data.capture.rows.length,1,'Login redirect must preserve an existing collection');
    assert.equal((await call('preview')).ok,true);
    assert.equal(creates,0);
    assert.equal((await call('resume')).ok,false);
    assert.equal((await call('start')).ok,true);
    const paused=await waitFor('paused');assert.match(paused.job.error,/did not finish/);
    assert.equal((await call('resume')).ok,true);
    const done=await waitFor('complete');
    assert.equal(done.job.rows[0].status,'done');assert.equal(creates,1);
    assert.ok(Object.keys(local).some(k=>k.startsWith('result:')));
    assert.equal(JSON.stringify(local).includes('secret'),false);
    await call('clear');assert.equal(Object.keys(local).some(k=>k.startsWith('result:')),false);
  } finally {globalThis.setTimeout=originalTimeout;globalThis.fetch=originalFetch;delete globalThis.chrome;}
});
