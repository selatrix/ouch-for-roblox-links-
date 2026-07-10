/**
 * Roblox Share Link Resolver Proxy
 * Resolves roblox.com/share?code=... to a numeric asset ID by following
 * HTTP redirects AND reading the page body (Roblox uses JS redirects).
 *
 * GET /resolve?url=<encoded_share_or_catalog_url>
 * → 200  { id: 107620597045824 }
 * → 400  { error: "..." }
 * → 404  { error: "...", finalUrl: "..." }
 */

const https = require("https");
const http  = require("http");
const PORT  = process.env.PORT || 3000;

const MAX_URL_LEN   = 512;
const ALLOWED_HOSTS = new Set(["roblox.com", "www.roblox.com"]);

/** Throw if the initial URL is not a safe Roblox https URL. */
function assertSafe(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); }
  catch { throw new Error("Invalid URL"); }
  if (parsed.protocol !== "https:")
    throw new Error("Only https:// URLs are accepted");
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`Host '${parsed.hostname}' is not allowed`);
  return parsed;
}

/**
 * Follow HTTP redirects freely (only initial URL is validated).
 * On the final non-redirect response, read and return the body so we can
 * search it for an asset ID — Roblox share links use JS redirects, not HTTP
 * redirects, so the ID lives in the page HTML rather than the Location header.
 *
 * Returns { finalUrl, body }
 */
function fetchFinal(startUrl, max = 10) {
  return new Promise((resolve, reject) => {
    let remaining = max;

    function step(url) {
      let parsed;
      try { parsed = new URL(url); }
      catch { return reject(new Error("Invalid redirect URL: " + url)); }

      const mod = parsed.protocol === "https:" ? https : http;

      const req = mod.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept":     "text/html,application/xhtml+xml,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }, (res) => {
        const { statusCode, headers } = res;

        // Follow HTTP redirects
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location && remaining-- > 0) {
          res.resume();
          return step(new URL(headers.location, url).href);
        }

        // Final response — read body (cap at 256 KB)
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 262144) chunks.push(chunk);
        });
        res.on("end", () => resolve({ finalUrl: url, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      });

      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("Request timed out")); });
    }

    step(startUrl);
  });
}

/**
 * Try to extract a numeric Roblox asset ID from a URL string or HTML body.
 * Patterns ordered from most to least specific.
 */
function extractId(url, body = "") {
  // 1. URL first — reliable if there was a real HTTP redirect to /catalog/<id>/
  const urlPatterns = [
    /roblox\.com\/catalog\/(\d+)/,
    /roblox\.com\/marketplace\/asset\/(\d+)/,
  ];
  for (const re of urlPatterns) {
    const m = url.match(re);
    if (m) return parseInt(m[1], 10);
  }
  // 2. Page body — Roblox embeds item data in __NEXT_DATA__ JSON and HTML
  const bodyPatterns = [
    /"assetId"\s*:\s*(\d+)/,
    /"AssetId"\s*:\s*(\d+)/,
    /"itemId"\s*:\s*(\d+)/,
    /"ItemId"\s*:\s*(\d+)/,
    /"id"\s*:\s*(\d+)\s*,\s*"[Nn]ame"/,
    /data-asset-id="(\d+)"/,
    /data-item-id="(\d+)"/,
    /\/catalog\/(\d+)\//,
    /\/marketplace\/asset\/(\d+)\//,
  ];
  for (const re of bodyPatterns) {
    const m = body.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const reqUrl = new URL(req.url, "http://localhost");

  // Landing page
  if (reqUrl.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Roblox Share Resolver</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e5e5ea;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#1c1c22;border:1px solid #2c2c32;border-radius:16px;
          padding:40px 48px;max-width:520px;width:100%}
    h1{font-size:1.4rem;font-weight:600;margin-bottom:8px}
    p{color:#8e8e93;font-size:.95rem;line-height:1.6;margin-bottom:20px}
    code{background:#2c2c32;border-radius:6px;padding:2px 7px;font-size:.88rem;color:#aeaeb2}
    .pill{display:inline-block;background:#2c2c32;border-radius:999px;
          padding:4px 14px;font-size:.8rem;color:#636366;margin-top:12px}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔗 Roblox Share Resolver</h1>
    <p>Internal proxy used by a Roblox game to resolve
       <code>roblox.com/share</code> links into numeric asset IDs.</p>
    <p>Endpoint: <code>GET /resolve?url=&lt;encoded_share_url&gt;</code></p>
    <span class="pill">● online</span>
  </div>
</body>
</html>`);
  }

  // Health / ping
  if (reqUrl.pathname === "/health" || reqUrl.pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (reqUrl.pathname !== "/resolve") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }

  const target = reqUrl.searchParams.get("url");

  if (!target) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing 'url' query parameter" }));
  }

  if (target.length > MAX_URL_LEN) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: `URL exceeds ${MAX_URL_LEN} character limit` }));
  }

  try { assertSafe(target); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: e.message }));
  }

  try {
    const { finalUrl, body } = await fetchFinal(target);
    const id = extractId(finalUrl, body);

    if (!id) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Could not extract asset ID", finalUrl }));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id }));

  } catch (err) {
    const status = err.message.includes("not allowed") || err.message.includes("Only https") ? 400 : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => console.log(`[ShareResolver] listening on port ${PORT}`));
