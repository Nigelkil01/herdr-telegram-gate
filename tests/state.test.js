'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gate-state-'));
const source = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8')
  .replace("const ROOT = __dirname;", `const ROOT = ${JSON.stringify(root)};`)
  .replace("const { classify } = require('./research/classify.js');", `const { classify } = require(${JSON.stringify(path.join(__dirname, '../research/classify.js'))});`)
  .replace(/main\(\)\.catch\(e => \{[\s\S]*?\}\);\s*$/, 'globalThis.api = { loadState, getPending, consumePending, removeStalePending: typeof removeStalePending === "undefined" ? null : removeStalePending };');
fs.copyFileSync(path.join(__dirname, '../policy.json'), path.join(root, 'policy.json'));
const ctx = { require: createRequire(path.join(__dirname, '../bot.js')), process, console, __dirname: root, setTimeout, Buffer };
vm.runInNewContext(source, ctx);
const file = path.join(root, 'state.json');
const future = new Date(Date.now() + 300000).toISOString();
const past = new Date(Date.now() - 300000).toISOString();
fs.writeFileSync(file, JSON.stringify({pending: {
  consumed: {id:'consumed', consumed:true, expires_at:future},
  expired: {id:'expired', expires_at:past},
  gone: {id:'gone', pane_id:'gone', expires_at:future},
  blocked: {id:'blocked', pane_id:'blocked', expires_at:future}
}}));
ctx.api.loadState();
assert.equal(ctx.api.getPending('consumed'), null, 'consumed entries are removed on load');
assert.equal(ctx.api.getPending('expired'), null, 'expired entries are removed on load');
ctx.api.removeStalePending([{pane_id:'blocked', agent_status:'blocked'}]);
assert.equal(ctx.api.getPending('gone'), null, 'gone panes are removed');
assert.ok(ctx.api.getPending('blocked'), 'blocked panes stay pending');
console.log('state cleanup passed');
