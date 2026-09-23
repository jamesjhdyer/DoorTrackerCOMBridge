'use strict';

// Error text can contain the network folder's location, a Windows path or a
// secret. Before it goes into a log line, a status file or the website's
// records, paths are replaced, control characters removed, and length capped.

function sanitizeText(text, { secrets = [], roots = [] } = {}) {
  let out = String(text === undefined || text === null ? '' : text);
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join('***');
  for (const root of roots) if (root) out = out.split(root).join('<archive>');
  return out
    .replace(/\\\\[^\s"']+/g, '<network path>')
    .replace(/\b[A-Za-z]:\\[^\s"']*/g, '<local path>')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 300);
}

module.exports = { sanitizeText };
