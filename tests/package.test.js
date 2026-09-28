import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('release archive contains only runtime files with bytes identical to the committed source',()=>{
  const output=execFileSync(process.execPath,[path.join(root,'tools','package-module.js')],{cwd:root,encoding:'utf8'});
  assert.match(output,/Verified \d+ files for MapGen/);
  const files=unzipSync(fs.readFileSync(path.join(root,'dist','mapgen.zip')));
  assert.ok(files['module.json']);
  assert.ok(files['scripts/mapgen.js']);
  assert.ok(files['templates/mapgen.hbs']);
  for(const [name,data]of Object.entries(files)) {
    assert.match(name,/^(?:module\.json|README\.md|(?:scripts|styles|templates|docs)\/[^.][^\\]*)$/);
    assert.doesNotMatch(name,/(?:^|\/)(?:node_modules|tests|test-output|\.git|\.copilot-tracking)\//);
    assert.deepEqual(Buffer.from(data),fs.readFileSync(path.join(root,...name.split('/'))));
  }
  const manifest=JSON.parse(Buffer.from(files['module.json']).toString('utf8'));
  assert.equal(manifest.id,'mapgen');
  assert.equal(manifest.download,`https://github.com/chrisgodfrey/mapgen/releases/download/v${manifest.version}/mapgen.zip`);
  assert.deepEqual(fs.readFileSync(path.join(root,'dist','module.json')),Buffer.from(files['module.json']));
});
