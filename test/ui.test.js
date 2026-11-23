import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

test('review UI paginates every row, filters, and renders imported text safely',async()=>{
  const html=await readFile(new URL('../extension/app.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://extension.test/app.html'});
  const rows=Array.from({length:31},(_,i)=>({firstName:i===0?'<img src=x onerror=alert(1)>':'Alex '+i,lastName:'Chen',linkedinUrl:'https://www.linkedin.com/in/test'+i,email:'',company:'Example',jobTitle:'Partner',headline:'',action:i===30?'review':'create',reason:'Test fixture',status:'pending',rowId:i}));
  const state={hasToken:true,job:{phase:'preview',rows,ownerId:''}};
  globalThis.document=dom.window.document;globalThis.Option=dom.window.Option;
  globalThis.chrome={runtime:{id:'test',async sendMessage(){return {ok:true,data:state};}},storage:{onChanged:{addListener(){}}}};
  await import('../extension/app.js?test');
  const $=id=>dom.window.document.getElementById(id);
  assert.equal($('rows').children.length,25);assert.equal($('rows').querySelectorAll('img').length,0);
  assert.match($('pageInfo').textContent,/1 to 25 of 31/);
  $('next').click();assert.equal($('rows').children.length,6);assert.match($('pageInfo').textContent,/26 to 31/);
  $('filter').value='review';$('filter').dispatchEvent(new dom.window.Event('change'));
  assert.equal($('rows').children.length,1);assert.match($('rows').textContent,/Alex 30/);
  dom.window.close();delete globalThis.document;delete globalThis.Option;delete globalThis.chrome;
});

test('CSV export works without CRM credentials and downloads all captured rows', async()=>{
  const html=await readFile(new URL('../extension/app.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://extension.test/app.html'});
  const capture={source:'csv',phase:'ready',reason:'All rows in the selected file loaded.',rows:Array.from({length:31},(_,i)=>({firstName:'Person '+i,lastName:'Example',linkedinUrl:'https://www.linkedin.com/in/example'+i,company:'Observed company',jobTitle:'Engineer',connectedOn:'20 Oct 2020'}))};
  const state={hasToken:false,capture};
  const messages=[];let blob,filename;
  const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  globalThis.document=dom.window.document;globalThis.Option=dom.window.Option;
  globalThis.chrome={runtime:{id:'test',async sendMessage(message){messages.push(message.type);return {ok:true,data:state};}},storage:{onChanged:{addListener(){}}}};
  URL.createObjectURL=value=>{blob=value;return 'blob:test';};
  URL.revokeObjectURL=()=>{};
  dom.window.HTMLAnchorElement.prototype.click=function(){filename=this.download;};
  try {
    await import('../extension/app.js?csv-export-test');
    const button=dom.window.document.getElementById('exportConnections');
    assert.equal(button.disabled,false);
    assert.equal(dom.window.document.getElementById('settings').hidden,true);
    button.click();
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(filename,'connections.csv');
    const csv=await blob.text();
    assert.equal(csv.split('\r\n').length,33);
    assert.match(csv,/Person 30 Example/);
    assert.match(csv,/20 Oct 2020/);
    assert.deepEqual([...new Set(messages)],['state']);
  } finally {
    URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;
    dom.window.close();delete globalThis.document;delete globalThis.Option;delete globalThis.chrome;
  }
});

test('import report export neutralizes whitespace prefixed spreadsheet formulas', async()=>{
  const html=await readFile(new URL('../extension/app.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://extension.test/app.html'});
  const rows=[{firstName:'Example',headline:'  =HYPERLINK("https://example.test")',action:'create',status:'pending'}];
  const state={hasToken:true,job:{phase:'preview',rows,ownerId:''}};
  const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
  let blob;
  globalThis.document=dom.window.document;globalThis.Option=dom.window.Option;
  globalThis.chrome={runtime:{id:'test',async sendMessage(){return {ok:true,data:state};}},storage:{onChanged:{addListener(){}}}};
  URL.createObjectURL=value=>{blob=value;return 'blob:test';};URL.revokeObjectURL=()=>{};
  dom.window.HTMLAnchorElement.prototype.click=function(){};
  try {
    await import('../extension/app.js?report-security-test');
    dom.window.document.getElementById('export').click();
    assert.ok((await blob.text()).includes('"\'  =HYPERLINK('));
  } finally {
    URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;
    dom.window.close();delete globalThis.document;delete globalThis.Option;delete globalThis.chrome;
  }
});
