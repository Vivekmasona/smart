// pages/api/proxy.js
// Fetches target page, rewrites relative URLs to absolute, injects a small script to detect mp4/video links and postMessage to parent.
// Note: keep this serverless-friendly: small memory/CPU use.

import fetch from 'node-fetch';
import cheerio from 'cheerio';
import { URL } from 'url';

export default async function handler(req, res) {
  const target = req.query.url;
  if (!target) {
    res.status(400).send('Missing url query parameter');
    return;
  }

  // Basic safety: disallow local/internal addresses
  try {
    const u = new URL(target);
    const host = u.hostname;
    // optionally add an allowlist/denylist here
    if (host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.endsWith('.internal')) {
      res.status(400).send('Local addresses not allowed');
      return;
    }
  } catch (e) {
    res.status(400).send('Invalid URL');
    return;
  }

  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VercelProxy/1.0)'
      },
      // follow redirects
      redirect: 'follow'
    });

    // Only handle HTML pages for injection
    const contentType = r.headers.get('content-type') || '';
    const text = await r.text();

    if (!contentType.includes('text/html')) {
      // If not HTML, simply proxy the raw response (like binary files) by redirecting to original URL
      // For non-HTML we can redirect to original resource so browser loads it directly
      res.status(302).setHeader('Location', target);
      res.end();
      return;
    }

    // Load into cheerio for simple manipulation
    const $ = cheerio.load(text);

    // Make relative links absolute (anchors, script src, link href, img/video/source src)
    const base = new URL(target);
    function makeAbs(i, elAttr, attr) {
      $(elAttr).each((i2, el) => {
        const val = $(el).attr(attr);
        if (!val) return;
        // skip data: and mailto:
        if (/^(data:|mailto:|javascript:|#)/i.test(val)) return;
        try {
          const abs = new URL(val, base).toString();
          $(el).attr(attr, abs);
        } catch (e) {
          // ignore
        }
      });
    }
    makeAbs(0, 'a', 'href');
    makeAbs(0, 'img', 'src');
    makeAbs(0, 'script', 'src');
    makeAbs(0, 'link', 'href');
    makeAbs(0, 'video', 'src');
    makeAbs(0, 'source', 'src');

    // Inject detection script before </body>
    const injected = `
<script>
(function(){
  function findMedia(){
    const list = [];
    // video tags
    document.querySelectorAll('video').forEach(v => {
      try {
        const src = v.currentSrc || v.src || (v.querySelector('source') && v.querySelector('source').src);
        if (src && src.match(/\\.mp4(\\?|$)/i)) list.push({url: src, title: (v.getAttribute('title')||document.title||'video')});
      } catch(e){}
    });
    // anchors that link to mp4
    document.querySelectorAll('a').forEach(a=>{
      try {
        const h = a.href;
        if (h && h.match(/\\.mp4(\\?|$)/i)) list.push({url: h, title: a.innerText.trim() || document.title});
      } catch(e){}
    });
    // dedupe
    const uniq = [];
    const seen = new Set();
    list.forEach(it=>{
      if(!seen.has(it.url)){ seen.add(it.url); uniq.push(it); }
    });
    parent.postMessage({type:'foundMedia', items: uniq}, '*');
  }

  findMedia();
  setTimeout(findMedia, 1500);
  const obs = new MutationObserver(findMedia);
  try { obs.observe(document.body || document.documentElement, {childList:true, subtree:true}); } catch(e){}
})();
</script>
    `;

    $('body').append(injected);

    // Return modified HTML. Important: do not set X-Frame-Options or CSP headers that block framing.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send($.html());
  } catch (err) {
    console.error('proxy error', err && err.message);
    res.status(500).send('Proxy fetch error');
  }
}
