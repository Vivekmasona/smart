// pages/api/download.js
// Streams remote file and forces Content-Disposition attachment so browser downloads.
// IMPORTANT: serverless execution time and memory limits exist on Vercel; large files may fail.
// Consider returning a redirect to the original URL for very large files.

import fetch from 'node-fetch';
import { URL } from 'url';

export default async function handler(req, res) {
  const fileUrl = req.query.url;
  if (!fileUrl) {
    res.status(400).send('Missing url');
    return;
  }

  try {
    // Basic safety: disallow internal hosts
    const u = new URL(fileUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.startsWith('192.168.')) {
      res.status(400).send('Local addresses not allowed');
      return;
    }

    // For large files it's safer to redirect the browser to the original URL:
    // But if you need to force download via our domain, stream it (may hit Vercel limits).
    // Simple heuristic: if target is large (content-length > 30MB) prefer redirect.
    const head = await fetch(fileUrl, { method: 'HEAD', redirect: 'follow' });
    const cl = head.headers.get('content-length');
    if (cl && parseInt(cl) > 30 * 1024 * 1024) {
      // Redirect so browser downloads directly from origin
      res.writeHead(302, { Location: fileUrl });
      res.end();
      return;
    }

    const r = await fetch(fileUrl, { redirect: 'follow' });
    if (!r.ok) {
      res.status(502).send('Failed to fetch file');
      return;
    }

    // derive filename
    let filename = 'download';
    try {
      const p = new URL(fileUrl).pathname;
      const last = p.split('/').pop();
      if (last) filename = decodeURIComponent(last);
    } catch (e) {}

    // set headers for attachment
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // Stream response body to client
    const reader = r.body.getReader();
    // Node response is writable stream (res)
    const stream = new ReadableStream({
      start(controller) {
        function push() {
          reader.read().then(({ done, value }) => {
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
            push();
          }).catch(err => {
            console.error('stream error', err);
            controller.error(err);
          });
        }
        push();
      }
    });

    // For Next.js serverless, convert to node stream
    const nodeStream = stream.pipeTo ? null : null; // noop (just to show intent)
    // Simpler: use Response's body directly (r.body is a Node.js readable stream in this environment)
    if (r.body && typeof r.body.pipe === 'function') {
      r.body.pipe(res);
    } else {
      // Fallback: buffer then send (risky for big files)
      const buf = await r.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error('download error', err && err.message);
    res.status(500).send('Download error');
  }
}
