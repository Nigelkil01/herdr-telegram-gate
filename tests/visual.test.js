'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'gate-visual-'));
fs.copyFileSync(path.join(__dirname, '../policy.json'), path.join(root, 'policy.json'));
const source = fs.readFileSync(path.join(__dirname, '../bot.js'), 'utf8')
  .replace('const ROOT = __dirname;', `const ROOT = ${JSON.stringify(root)};`)
  .replace("const { classify } = require('./research/classify.js');", `const { classify } = require(${JSON.stringify(path.join(__dirname, '../research/classify.js'))});`)
  .replace(/main\(\)\.catch\(e => \{[\s\S]*?\}\);\s*$/, `
    tgAnswerCallback = async () => {};
    tgSendMessage = async () => ({message_id: 99});
    herdrAgentSendKeys = async () => { throw new Error('visual pressed keys'); };
    globalThis.api = {handleCallbackQuery, handleMessage};`);
const proc = { ...process, env: { ...process.env, TELEGRAM_OWNER_ID: '123' } };
const ctx = { require: createRequire(path.join(__dirname, '../bot.js')), process: proc, console, __dirname: root, setTimeout, Buffer };
vm.runInNewContext(source, ctx);
(async () => {
  const message = {message_id: 42, chat: {id: 123}, caption: 'HTRG-1 mockup'};
  await ctx.api.handleCallbackQuery({id:'x', from:{id:999}, message, data:'visual:approve'});
  assert.equal(fs.existsSync(path.join(root, 'visual-feedback.jsonl')), false, 'non-owner cannot record feedback');
  await ctx.api.handleCallbackQuery({id:'a', from:{id:123}, message, data:'visual:changes'});
  await ctx.api.handleCallbackQuery({id:'b', from:{id:123}, message, data:'visual:approve'});
  await ctx.api.handleMessage({from:{id:123}, chat:{id:123}, reply_to_message:{message_id:99}, text:'Move the heading'});
  const log = fs.readFileSync(path.join(root, 'visual-feedback.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 2, 'duplicate taps do not record another choice');
  assert.equal(log[0].choice, 'changes');
  assert.equal(log[0].caption, 'HTRG-1 mockup');
  assert.equal(log[1].reply, 'Move the heading');
  console.log('visual feedback passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
