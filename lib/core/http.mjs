// A small router for v2 routes. A handler returns an object (sent as 200 JSON)
// or throws HttpError; anything else thrown becomes a 500 with its message.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const keys = [];
      const source = pattern.split('/')
        .map(seg => seg.startsWith(':') ? (keys.push(seg.slice(1)), '([^/]+)') : escapeRe(seg))
        .join('/');
      routes.push({ method, re: new RegExp(`^${source}$`), keys, handler, pattern });
    },
    routes() { return routes.map(r => `${r.method} ${r.pattern}`); },
    async handle(req, res, url) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        try {
          const params = {};
          r.keys.forEach((k, i) => {
            try { params[k] = decodeURIComponent(m[i + 1]); }
            catch { throw new HttpError(400, `bad path segment for ${k}`); }
          });
          let parsed;
          const body = async () => {
            if (parsed === undefined) {
              const text = await readBody(req);
              try { parsed = text.trim() ? JSON.parse(text) : {}; }
              catch { throw new HttpError(400, 'request body is not JSON'); }
            }
            return parsed;
          };
          const out = await r.handler(req, res, { params, query: url.searchParams, body });
          if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out === undefined ? { ok: true } : out);
        } catch (e) {
          if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || String(e) });
          else if (!res.writableEnded) res.end();
        }
        return true;
      }
      return false;
    },
  };
}
