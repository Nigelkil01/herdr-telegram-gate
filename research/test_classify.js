'use strict';
/**
 * test_classify.js — accuracy harness.
 *
 * The KPI is NOT overall accuracy. It is:
 *   unsafe -> safer false negatives MUST be 0.
 * A false negative is any sample whose true tier is HIGHER (more dangerous)
 * than the tier classify.js assigned. Those are the ones that get auto-approved
 * and hurt someone. Everything else is at worst an annoyance.
 */

const fs = require('fs');
const path = require('path');
const { classify } = require('./classify');

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus/corpus.json'), 'utf8'));
const samples = corpus.samples;

const results = [];
let exact = 0;
const falseNegatives = [];   // predicted tier < expected tier  => DANGEROUS
const falsePositives = [];   // predicted tier > expected tier  => noisy, acceptable

for (const s of samples) {
  let r;
  try {
    r = classify(s.text, s.agent, { cwd: s.cwd || '/home/dom/projects/gate' });
  } catch (e) {
    r = { tier: 2, action: 'exception', reason: e.message, rule: 'threw' };
  }
  const rec = { id: s.id, agent: s.agent, expected: s.expect_tier, got: r.tier,
                action: r.action, rule: r.rule, reason: r.reason, why: s._why };
  results.push(rec);

  if (r.tier === s.expect_tier) exact++;
  else if (r.tier < s.expect_tier) falseNegatives.push(rec);
  else falsePositives.push(rec);
}

const byTier = { 0: 0, 1: 0, 2: 0 };
for (const r of results) byTier[r.got]++;

const line = '─'.repeat(72);
console.log(line);
console.log('herdr-telegram-gate — classifier accuracy report');
console.log(`corpus: ${samples.length} samples   classifier: classify.js`);
console.log(line);
console.log(`exact tier match      : ${exact}/${samples.length}  (${(exact / samples.length * 100).toFixed(1)}%)`);
console.log(`FALSE NEGATIVES (KPI) : ${falseNegatives.length}   <-- MUST BE 0`);
console.log(`false positives       : ${falsePositives.length}   (over-escalation; safe but noisy)`);
console.log(line);
console.log(`predicted tier spread : T0=${byTier[0]}  T1=${byTier[1]}  T2=${byTier[2]}`);
console.log(`auto-approve coverage : ${((byTier[0] + byTier[1]) / samples.length * 100).toFixed(1)}% of all blocks`);
console.log(line);

if (falseNegatives.length) {
  console.log('\n!! FALSE NEGATIVES — these would have been auto-approved wrongly:\n');
  for (const f of falseNegatives) {
    console.log(`  ${f.id} [${f.agent}] expected T${f.expected} got T${f.got}`);
    console.log(`     rule=${f.rule} reason=${f.reason}`);
    if (f.why) console.log(`     ${f.why}`);
  }
} else {
  console.log('\nOK — zero unsafe misclassifications. Fail-closed held on every sample.\n');
}

if (falsePositives.length) {
  console.log('\nOver-escalated (safe, but costs auto-approve coverage):\n');
  for (const f of falsePositives) {
    console.log(`  ${f.id} [${f.agent}] expected T${f.expected} got T${f.got}  rule=${f.rule}`);
    console.log(`     ${f.reason}`);
  }
}

// Adversarial subset is the part that actually matters.
const adv = results.filter((r) => r.id.startsWith('adv-'));
const advCaught = adv.filter((r) => r.got === 2).length;
console.log(`\n${line}`);
console.log(`adversarial subset    : ${advCaught}/${adv.length} correctly escalated to T2`);
console.log(line);

fs.writeFileSync(path.join(__dirname, 'results.json'),
  JSON.stringify({ summary: { total: samples.length, exact, falseNegatives: falseNegatives.length,
    falsePositives: falsePositives.length, byTier }, results }, null, 2));

process.exit(falseNegatives.length === 0 ? 0 : 1);
