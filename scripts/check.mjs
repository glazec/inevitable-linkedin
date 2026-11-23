import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root=new URL('../extension/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
if(manifest.manifest_version!==3)throw new Error('Manifest V3 required');
for(const file of await readdir(root))if(file.endsWith('.js'))execFileSync(process.execPath,['--check',new URL(file,root).pathname]);
const html=await readFile(new URL('app.html',root),'utf8');
if(/<script(?![^>]*src=)[^>]*>/i.test(html)||/\son\w+=/i.test(html))throw new Error('Inline scripts forbidden');
console.log('Manifest, JavaScript syntax and extension CSP checks passed.');
