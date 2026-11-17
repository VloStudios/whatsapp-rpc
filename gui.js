// Tiny local web server for the GUI: serves the page, streams state over SSE, accepts actions.
// Bound to 127.0.0.1 only; requests are checked against DNS-rebinding and cross-site POSTs.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function startGui({ port, getState, onAction }) {
  const token = crypto.randomBytes(16).toString('hex');
  const clients = new Set();
  const html = fs
    .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace('__TOKEN__', token);
  let allowedHosts = new Set();

  const server = http.createServer((req, res) => {
    // DNS-rebinding protection: only answer for our own loopback host names
    if (!allowedHosts.has(req.headers.host)) { res.writeHead(403); return res.end('forbidden'); }

    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url === '/api/action') {
      const okType = (req.headers['content-type'] || '').startsWith('application/json');
      if (!okType || req.headers['x-token'] !== token) { res.writeHead(403); return res.end('forbidden'); }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
      req.on('end', async () => {
        let reply;
        try { await onAction(JSON.parse(body)); reply = { ok: true }; }
        catch (e) { reply = { ok: false, error: e.message }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
      return;
    }

    res.writeHead(404); res.end('not found');
  });

  const heartbeat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);
  heartbeat.unref();

  function broadcast() {
    if (!clients.size) return;
    const msg = `data: ${JSON.stringify(getState())}\n\n`;
    for (const c of clients) c.write(msg);
  }

  // Try a few ports in case the first is taken
  function listen(p, tries) {
    return new Promise((resolve, reject) => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries > 0) resolve(listen(p + 1, tries - 1));
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => {
        server.removeAllListeners('error');
        allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
        resolve({ url: `http://127.0.0.1:${p}`, port: p });
      });
    });
  }

  return listen(port, 10).then(({ url }) => ({
    url,
    broadcast,
    close: () => { clearInterval(heartbeat); for (const c of clients) c.end(); server.close(); },
  }));
}

module.exports = { startGui };
