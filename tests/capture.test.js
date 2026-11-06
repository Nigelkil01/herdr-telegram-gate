'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { scrub } = require('../scripts/capture-blocked-pane');

const reconstructed = fs.readFileSync(path.join(__dirname, 'fixtures/claude-approval-unverified.txt'), 'utf8');
const sample = reconstructed + '\n/home/example/private.txt\n~/notes\nC:\\Users\\example\\notes\nalice@example.com\nhost.example.com\nhostname: internal-box\nfake-host\n+1 (202) 555-0123\npassword=synthetic123\n-----BEGIN PRIVATE KEY-----\nFAKEKEYBODY\n-----END PRIVATE KEY-----\n';
const clean = scrub(sample, 'fake-host');
for (const value of ['/home/example', '~/notes', 'C:\\Users\\example', 'alice@example.com', 'host.example.com', 'internal-box', 'fake-host', '202) 555-0123', 'synthetic123', 'FAKEKEYBODY']) {
  assert(!clean.includes(value), `synthetic sensitive value was not scrubbed: ${value}`);
}
for (const value of ['Bash command', 'printf hello', '[HOME_PATH]', '[EMAIL]', '[HOSTNAME]', '[PHONE]', 'password=REDACTED', 'REDACTED KEY']) {
  assert(clean.includes(value), `expected scrubbed fixture content: ${value}`);
}
assert(scrub('write /tmp/htrg-capture-test.txt', 'fake-host').includes('/tmp/htrg-capture-test.txt'));
console.log('capture scrub passed (synthetic sample)');
