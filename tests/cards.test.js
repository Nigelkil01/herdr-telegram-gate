'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gate-cards-'));
fs.copyFileSync(path.join(__dirname, '../policy.json'), path.join(root, 'policy.json'));
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/codex-approval.txt'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8')
  .replace('const ROOT = __dirname;', `const ROOT = ${JSON.stringify(root)};`)
  .replace("const { classify } = require('./research/classify.js');", `const { classify } = require(${JSON.stringify(path.join(__dirname, '../research/classify.js'))});`)
  .replace(/main\(\)\.catch\(e => \{[\s\S]*?\}\);\s*$/, `
    herdrAgentGet = async () => ({agent:'codex',display_agent:'agent · working',name:'worker',title:'HTRG-1 test',pane_id:'w1:p1',cwd:'/tmp',agent_status:'blocked',state_change_seq:globalThis.seq});
    herdrAgentRead = async () => globalThis.fixture;
    tgSendMessage = async (text) => {globalThis.sent = text; return {message_id:1}};
    tgAnswerCallback = async () => {};
    tgEditMessage = async () => {};
    herdrAgentSendKeys = async () => {globalThis.keyCount++};
    globalThis.api = {handleBlocked, executeCallback, requestScreen, approvalMessage};`);
const proc = {...process, env:{...process.env, TELEGRAM_OWNER_ID:'123'}};
const ctx = { require: createRequire(path.join(__dirname, '../bot.js')), process:proc, console, __dirname:root, setTimeout, Buffer, fixture, keyCount:0, seq:1 };
vm.runInNewContext(source, ctx);
(async () => {
  await ctx.api.handleBlocked('w1:p1');
  assert.match(ctx.sent, /codex/);
  assert.match(ctx.sent, /HTRG-1/);
  assert.match(ctx.sent, /\$ ls \/tmp/);
  const id = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).pending)[0];
  ctx.fixture = fixture.replace('ls /tmp', 'pwd');
  await ctx.api.executeCallback({id:'tap',from:{id:123},message:{chat:{id:123},message_id:1},data:`app:${id}`}, 'approve');
  assert.equal(ctx.keyCount, 0, 'changed screen never presses keys');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).pending).length, 0);
  ctx.fixture = fixture;
  ctx.seq++;
  await ctx.api.handleBlocked('w1:p1');
  const approved = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).pending)[0];
  await ctx.api.executeCallback({id:'tap2',from:{id:123},message:{chat:{id:123},message_id:2},data:`app:${approved}`}, 'approve');
  assert.equal(ctx.keyCount, 1, 'unchanged screen accepts one approval');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).pending).length, 0, 'approved entry is removed');
  ctx.seq++;
  await ctx.api.handleBlocked('w1:p1');
  const denied = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).pending)[0];
  await ctx.api.executeCallback({id:'tap3',from:{id:123},message:{chat:{id:123},message_id:3},data:`den:${denied}`}, 'deny');
  assert.equal(ctx.keyCount, 2, 'denial sends one key');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state.json'))).pending).length, 0, 'denied entry is removed');
  const claude = fs.readFileSync(path.join(__dirname, 'fixtures/claude-approval-unverified.txt'), 'utf8');
  assert.match(ctx.api.requestScreen(claude), /printf hello/);
  const question = 'Do you want to continue with this approach?\n\n❯ Yes\n  No';
  assert.equal(ctx.api.requestScreen(question), question);
  assert.match(ctx.api.approvalMessage({agent:'codex',pane_id:'p',task_id:'HTRG-1',screen:question,tier:2,expires_at:new Date().toISOString()}), /Do you want to continue with this approach/);
  console.log('captured approval card and reconstructed question passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
