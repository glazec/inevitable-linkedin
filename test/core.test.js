import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedinUrl,parseCSV,buildPlan,stableId,personInput,pairKey} from '../extension/core.js';
const row={firstName:'Alex',lastName:'Chen',linkedinUrl:'https://www.linkedin.com/in/alex',email:'alex@example.com'};
const person=(id,url,email='')=>({id,linkedinLink:{primaryLinkUrl:url},emails:{primaryEmail:email}});

test('canonicalizes profile URLs and rejects deceptive hosts and nonprofiles',()=>{
  assert.equal(linkedinUrl('https://uk.linkedin.com/in/Alex/?trk=123'),'https://www.linkedin.com/in/alex');
  assert.equal(linkedinUrl('https://linkedin.com.evil.test/in/alex'),'');
  assert.equal(linkedinUrl('javascript:alert(1)'),'');
  assert.equal(linkedinUrl('https://linkedin.com/company/alex'),'');
  assert.equal(linkedinUrl('https://linkedin.com/in/a%2Fb'),'');
  assert.equal(linkedinUrl('https://linkedin.com/in/%E6%9D%8E'),'https://www.linkedin.com/in/%E6%9D%8E');
});
test('reads LinkedIn preamble, BOM, quotes, Unicode, CRLF and multiline fields',()=>{
  const text='\uFEFFNotes:\r\nSome email addresses are missing.\r\n\r\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\r\nAlex,陈,https://linkedin.com/in/alex,ALEX@example.com,"Example, Inc.","Partner\nResearch",13 Oct 2026\r\n';
  const [r]=parseCSV(text);assert.equal(r.lastName,'陈');assert.equal(r.company,'Example, Inc.');assert.equal(r.jobTitle,'Partner\nResearch');assert.equal(r.email,'alex@example.com');
  assert.throws(()=>parseCSV('First Name,Last Name\n"Alex,Chen'),/unclosed/);
  assert.throws(()=>parseCSV('name,email\nAlex,a@a.com'),/Connections.csv/);
});
test('reuses URL and secondary email identities without overwriting',()=>{
  const p=person('1','https://linkedin.com/in/alex/');
  p.emails.additionalEmails=['other@example.com'];
  const plan=buildPlan([row,{firstName:'Other',email:'other@example.com'}],[p]);
  assert.deepEqual(plan.map(r=>r.action),['existing','existing']);
  assert.equal(plan[0].personId,'1');
});
test('excludes conflicting CRM identities and source duplicates',()=>{
  const p=person('1',row.linkedinUrl),q=person('2','https://linkedin.com/in/different',row.email);
  assert.equal(buildPlan([row],[p,q])[0].action,'review');
  assert.equal(buildPlan([row],[q])[0].action,'review');
  assert.deepEqual(buildPlan([row,row],[]).map(r=>r.action),['create','skip']);
});
test('rejects nameless and unidentifiable rows and avoids guessing companies',()=>{
  const plan=buildPlan([{firstName:'Alex'},{linkedinUrl:row.linkedinUrl},{...row,company:'Example'}],[],[{id:'1',name:'Example'},{id:'2',name:'Example'}]);
  assert.deepEqual(plan.map(r=>r.action),['review','review','create']);assert.equal(plan[2].companyId,null);
  assert.ok(plan[2].companyNote);
  assert.equal(buildPlan([{...row,company:'Example'}],[],[{id:'1',name:'example'}])[0].companyId,'1');
});
test('stable identities persist across retries and relationship direction',async()=>{
  assert.equal(await stableId('a'),await stableId('a'));assert.notEqual(await stableId('a'),await stableId('b'));
  assert.match(await stableId('a'),/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(pairKey('b','a'),pairKey('a','b'));
});
test('all source rows sharing an email across different profiles require review',()=>{
  assert.deepEqual(buildPlan([row,{...row,linkedinUrl:'https://linkedin.com/in/other'}],[]).map(r=>r.action),['review','review']);
});
test('only observed fields are written; headline is not invented job title',()=>{
  const input=personInput({...row,headline:'Founder | Investor | Builder'},'id');
  assert.equal(input.jobTitle,undefined);assert.equal(input.companyId,undefined);assert.equal(input.ingestionSources,undefined);
  assert.deepEqual(input.name,{firstName:'Alex',lastName:'Chen'});
});
