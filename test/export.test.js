import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionCSV,csvText,connectionSummary} from '../extension/export.js';
import {parseCSV} from '../extension/core.js';

test('exports all captured rows without a CRM job, preserves dates and flags incomplete coverage',()=>{
  const rows=parseCSV('First Name,Last Name,URL,Company,Position,Connected On\nAlex,Example,https://www.linkedin.com/in/example,"Example, Inc.",Engineer,12 Oct 2020');
  const csv=connectionCSV({rows:[...rows,...rows],source:'csv',phase:'ready',reason:'File coverage unverified'});
  assert.equal(csv.split('\r\n').length,4);
  assert.match(csv,/Example, Inc\./);
  assert.match(csv,/12 Oct 2020/);
  assert.doesNotMatch(csv,/File coverage unverified/);
  assert.equal(connectionSummary({rows,expected:3,reason:'File coverage unverified'}).count_difference,2);
  assert.match(csv,/earliest_listed_full_time_start/);
  assert.doesNotMatch(csv,/enrichment_status|expected_connections|coverage/);
});

test('CSV escapes quotes and multiline values and neutralizes whitespace prefixed formulas',()=>{
  assert.equal(csvText(['name'],[{name:'  =HYPERLINK("bad")'}]),'\uFEFF"name"\r\n"\'  =HYPERLINK(""bad"")"\r\n');
  assert.match(csvText(['name'],[{name:'A\nB'}]),/"A\nB"/);
});

test('export cannot silently snapshot a running or empty collection',()=>{
  assert.throws(()=>connectionCSV({rows:[]}),/Collect connections/);
  assert.throws(()=>connectionCSV({rows:[{}],phase:'collecting'}),/Finish or stop/);
});
