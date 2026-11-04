'use strict';

function redactSecrets(str) {
  if (!str) return str;
  return String(str)
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-REDACTED')
    .replace(/(token|password|passwd|secret|api[_-]?key|auth)["'\s]*[:=]\s*["']?[^"'\s\n]{4,}/gi, '$1=REDACTED')
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '-----REDACTED KEY-----')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{8,}/gi, 'Bearer REDACTED');
}

module.exports = { redactSecrets };
