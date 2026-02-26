import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

const rootDir = resolve('app/website');
const port = Number(process.env.PORT || 4173);

const mimeByExt = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
  const filePath = join(rootDir, urlPath.replace(/^\/+/, ''));

  if (!filePath.startsWith(rootDir) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const contentType = mimeByExt[extname(filePath)] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Website running at http://localhost:${port}`);
});
