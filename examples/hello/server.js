// The example tool: a web server that logs every request. Deck passes the
// port as --port and the greeting as GREETING (see examples/tools/hello.json).
const http = require('http');
const i = process.argv.indexOf('--port');
const port = Number(i > 0 ? process.argv[i + 1] : 8899);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const greeting = esc(process.env.GREETING || 'Hello from Deck');
http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${greeting}</title><body style="font:16px system-ui;background:#0a0d12;color:#e8eef4;display:grid;place-items:center;height:100vh;margin:0"><p>${greeting}, on port ${port}.</p>`);
}).listen(port, '127.0.0.1', () => console.log(`listening on http://localhost:${port}`));
