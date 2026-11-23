import test from 'node:test';
import assert from 'node:assert/strict';
import {CRM} from '../extension/crm.js';
import {API_URLS,stableId} from '../extension/core.js';
const reply=data=>({ok:true,json:async()=>({data})});
const page=(nodes,next=false,cursor=null)=>({edges:nodes.map(node=>({node})),pageInfo:{hasNextPage:next,endCursor:cursor}});
const config={apiUrl:API_URLS[1],token:'secret'};

test('calls browser fetch without binding it to the CRM instance',async()=>{
  const crm=new CRM(config,async function(){
    assert.equal(this,undefined,'Browser fetch rejects a CRM object as its receiver');
    return reply({people:page([])});
  },0);
  await crm.all('people','id');
});

test('exhausts all CRM pages and rejects repeated cursors',async()=>{
  let calls=0;
  const crm=new CRM(config,async()=>reply({people:page([{id:String(++calls)}],calls<3,'cursor'+calls)}),0);
  assert.equal((await crm.all('people','id')).length,3);
  const broken=new CRM(config,async()=>reply({people:page([],true,'same')}),0);
  await assert.rejects(broken.all('people','id'),/stalled/);
});
test('HTTP failures pause without blindly retrying mutations or leaking server data',async()=>{
  let calls=0;
  const crm=new CRM(config,async()=>{calls++;return {ok:false,status:429};},0);
  await assert.rejects(crm.create('person','PersonCreateInput',{id:'x'}),/rate limit/);
  assert.equal(calls,1);
  const auth=new CRM(config,async()=>({ok:false,status:401}),0);
  await assert.rejects(auth.all('people','id'),/API key/);
  const gql=new CRM(config,async()=>({ok:true,json:async()=>({errors:[{message:'secret'}]})}),0);
  await assert.rejects(gql.all('people','id'),error=>!error.message.includes('secret'));
});
test('recovers a person committed before the network response was lost',async()=>{
  const row={firstName:'Alex',lastName:'Chen',linkedinUrl:'https://www.linkedin.com/in/alex',email:''};
  const saved=new Map();let creates=0;
  const crm=new CRM(config,async(_url,init)=>{
    const {query,variables}=JSON.parse(init.body);
    if(query.startsWith('mutation')) {
      creates++;const p={...variables.data};saved.set(p.id,p);throw new Error('response lost');
    }
    const id=query.match(/id:\{eq:"([^"]+)"/i)?.[1];
    return reply({people:page(id&&saved.has(id)?[saved.get(id)]:[])});
  },0);
  await assert.rejects(crm.ensurePerson(row),/did not finish/);
  assert.equal(await crm.ensurePerson(row),await stableId('person:'+row.linkedinUrl));
  assert.equal(creates,1);
});
test('relationship retry repairs missing participants without creating a second relationship',async()=>{
  const records={socialConnections:new Map(),socialConnectionParticipants:new Map()};let mutations=0,failed=false;
  const crm=new CRM(config,async(_url,init)=>{
    const {query,variables}=JSON.parse(init.body);
    if(query.startsWith('mutation')){
      const key=query.match(/\{ (create\w+)\(/)[1];const plural=key==='createSocialConnection'?'socialConnections':'socialConnectionParticipants';
      records[plural].set(variables.data.id,variables.data);mutations++;
      if(plural==='socialConnectionParticipants'&&!failed){failed=true;throw new Error('lost');}
      return reply({[key]:{id:variables.data.id}});
    }
    const plural=query.match(/\{ (\w+)\(/)[1];
    const id=query.match(/filter:\{id:\{eq:"([^"]+)"/)?.[1];
    let matches=[...records[plural].values()];
    if(id)matches=matches.filter(r=>r.id===id);
    else if(plural==='socialConnectionParticipants'){
      const pid=query.match(/personId:\{eq:"([^"]+)"/)?.[1];matches=matches.filter(r=>r.personId===pid);
    }
    return reply({[plural]:page(matches)});
  },0);
  const row={linkedinUrl:'https://www.linkedin.com/in/alex'};
  await assert.rejects(crm.ensureRelationship('owner','contact',row,'2026-10-13T00:00:00Z'));
  await crm.ensureRelationship('owner','contact',row,'2026-10-13T00:00:00Z');
  assert.equal(records.socialConnections.size,1);assert.equal(records.socialConnectionParticipants.size,2);assert.equal(mutations,3);
});
test('credentials are limited to the selected endpoint and never sent via redirects',async()=>{
  assert.throws(()=>new CRM({apiUrl:'https://evil.test',token:'x'}),/Unsupported/);
  const crm=new CRM(config,async(url,init)=>{
    assert.equal(url,API_URLS[1]+'/graphql');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    return reply({people:page([])});
  },0);
  await crm.all('people','id');
});
