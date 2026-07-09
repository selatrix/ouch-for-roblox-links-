/**
 * Roblox Share Link Resolver Proxy
 * Follows roblox.com/share?code=... redirects and returns the numeric asset ID.
 * Deploy to Render (or any Node host) — set the URL in your Roblox server script.
 *
 * GET /resolve?url=<encoded_share_or_catalog_url>
 * → 200  { id: 107620597045824 }
 * → 400  { error: "..." }
 * → 404  { error: "...", finalUrl: "..." }
 */

const https  = require("https");
const http   = require("http");
const PORT   = process.env.PORT || 3000;
const MAX_URL_LEN    = 512;
const ALLOWED_HOSTS  = new Set(["roblox.com", "www.roblox.com"]);
const ALLOWED_PROTOS = new Set(["https:"]);

/** Throw if the URL is not a safe Roblox https URL. */
function assertSafe(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); }
  catch { throw new Error("Invalid URL"); }

  if (!ALLOWED_PROTOS.has(parsed.protocol))
    throw new Error("Only https:// URLs are accepted");

  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`Host '${parsed.hostname}' is not allowed`);

  return parsed;
}

/**
 * Follow redirects, re-validating each hop against the allowlist.
 * Returns the final URL (string).
 */
function followRedirects(startUrl, max = 8) {
  return new Promise((resolve, reject) => {
    let remaining = max;

    function step(url) {
      // Validate before every request
      let parsed;
      try { parsed = assertSafe(url); }
      catch (e) { return reject(e); }

      const req = https.get(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; RobloxShareResolver/1.0)",
            "Accept":     "text/html,application/xhtml+xml,*/*",
          },
        },
        (res) => {
          res.resume(); // drain body; we only care about headers

          const { statusCode, headers } = res;

          if (
            [301, 302, 303, 307, 308].includes(statusCode) &&
            headers.location &&
            remaining-- > 0
          ) {
            const next = new URL(headers.location, url).href;
            return step(next);
          }

          resolve(url);
        }
      );

      req.on("error", reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error("Request timed out")); });
    }

    step(startUrl);
  });
}

/** Extract a numeric Roblox asset ID from a URL string. */
function extractId(url) {
  const patterns = [
    /roblox\.com\/catalog\/(\d+)/,
    /roblox\.com\/marketplace\/asset\/(\d+)/,
    /[?&]id=(\d+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const reqUrl = new URL(req.url, `http://localhost`);

  // Health-check / ping (point UptimeRobot at /ping or /health)
  if (["/" , "/health", "/ping"].includes(reqUrl.pathname)) {
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

  // Validate the target URL before touching the network
  try { assertSafe(target); }
  catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: e.message }));
  }

  try {
    const finalUrl = await followRedirects(target);
    const id       = extractId(finalUrl);

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
