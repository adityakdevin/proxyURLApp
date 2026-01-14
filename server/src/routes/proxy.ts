import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { SessionService } from '../services/sessionService.js';
import { ProxyService } from '../services/proxyService.js';
import { AuditLogService } from '../services/auditLogService.js';
import http from 'http';
import https from 'https';

const router = Router();

// Store target URLs for each opaqueId (in-memory cache)
const targetUrlCache = new Map<string, { targetUrl: string; host: string; protocol: string }>();

// Extract root domain from host (e.g., "www.tataaig.com" -> "tataaig.com")
function getRootDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return host;
}

// Generate intercept script for client-side URL rewriting
function generateInterceptScript(opaqueId: string, host: string, baseUrl: string): string {
  // Use relative URL to work with any frontend port
  const localProxyBase = `/proxy/${opaqueId}/`;
  const rootDomain = getRootDomain(host);
  return `
<script>
(function() {
    var opaqueId = '${opaqueId}';
    var originalHost = '${host}';
    var rootDomain = '${rootDomain}';
    var baseUrl = '${baseUrl}';
    var localProxyBase = '${localProxyBase}';

    // Check if URL belongs to same root domain (handles subdomains like api.tataaig.com)
    function isSameDomain(url) {
        if (!url) return false;
        try {
            // Handle protocol-relative URLs
            if (url.indexOf('//') === 0) {
                url = 'https:' + url;
            }
            if (url.indexOf('://') !== -1) {
                var match = url.match(/:\\/\\/([^\\/:]+)/);
                if (match && match[1]) {
                    var urlHost = match[1].toLowerCase();
                    return urlHost === originalHost || urlHost.endsWith('.' + rootDomain) || urlHost === rootDomain;
                }
            }
        } catch(e) {}
        return false;
    }

    function rewriteUrl(url) {
        if (!url || typeof url !== 'string') return url;
        if (url.indexOf('/proxy/' + opaqueId) !== -1) return url;

        // Handle cross-domain requests to same root domain (e.g., api.tataaig.com)
        if (url.indexOf('://') !== -1 || url.indexOf('//') === 0) {
            if (isSameDomain(url)) {
                // Encode the full URL and route through external proxy
                var encodedUrl = btoa(url).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
                return '/proxy/' + opaqueId + '/_ext/' + encodedUrl;
            }
            // External domain - don't rewrite
            return url;
        }

        // Handle same-host URLs
        if (url.indexOf(originalHost) !== -1) {
            var hostIndex = url.indexOf(originalHost);
            var pathStart = url.indexOf('/', hostIndex + originalHost.length);
            if (pathStart !== -1) {
                return localProxyBase + url.substring(pathStart + 1);
            }
            return localProxyBase;
        }
        if (url.charAt(0) === '/') {
            if (url.indexOf('/proxy/') === 0) return url;
            return localProxyBase + url.substring(1);
        }
        if (url.indexOf('://') === -1 && url.indexOf('data:') !== 0 && url.indexOf('javascript:') !== 0 && url.indexOf('#') !== 0) {
            return localProxyBase + url;
        }
        return url;
    }

    // Patch XMLHttpRequest prototype directly to avoid "Illegal invocation" errors
    var OriginalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
        var newUrl = rewriteUrl(url);
        console.log('[Proxy] XHR open:', method, url, '->', newUrl);
        this._proxyUrl = newUrl;
        return OriginalXHROpen.call(this, method, newUrl, async !== false, user, pass);
    };

    // Also patch send to handle FormData and other body types
    var OriginalXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        console.log('[Proxy] XHR send:', this._proxyUrl);
        return OriginalXHRSend.call(this, body);
    };

    var originalFetch = window.fetch;
    window.fetch = function(input, options) {
        var url, newUrl;
        if (typeof input === 'string') {
            url = input;
            newUrl = rewriteUrl(url);
            console.log('[Proxy] fetch:', url, '->', newUrl);
            return originalFetch.call(window, newUrl, options);
        } else if (input instanceof Request) {
            url = input.url;
            newUrl = rewriteUrl(url);
            console.log('[Proxy] fetch Request:', url, '->', newUrl);
            // Create new request with rewritten URL
            var newRequest = new Request(newUrl, input);
            return originalFetch.call(window, newRequest, options);
        }
        return originalFetch.call(window, input, options);
    };

    function patchJQuery() {
        if (window.jQuery && !window.jQuery.__proxyPatched) {
            window.jQuery.__proxyPatched = true;
            console.log('[Proxy] Patching jQuery.ajax');
            var originalAjax = window.jQuery.ajax;
            window.jQuery.ajax = function(urlOrSettings, settings) {
                var opts = typeof urlOrSettings === 'string' ? (settings || {}) : urlOrSettings;
                var url = typeof urlOrSettings === 'string' ? urlOrSettings : opts.url;
                var newUrl = rewriteUrl(url);
                console.log('[Proxy] jQuery.ajax:', url, '->', newUrl);
                if (typeof urlOrSettings === 'string') {
                    return originalAjax.call(window.jQuery, newUrl, settings);
                } else {
                    opts.url = newUrl;
                    return originalAjax.call(window.jQuery, opts);
                }
            };
        }
    }

    patchJQuery();
    document.addEventListener('DOMContentLoaded', patchJQuery);
    setTimeout(patchJQuery, 100);
    setTimeout(patchJQuery, 500);

    var originalImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (originalImageSrc) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
            get: function() { return originalImageSrc.get.call(this); },
            set: function(value) { return originalImageSrc.set.call(this, rewriteUrl(value)); }
        });
    }

    var originalScriptSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    if (originalScriptSrc) {
        Object.defineProperty(HTMLScriptElement.prototype, 'src', {
            get: function() { return originalScriptSrc.get.call(this); },
            set: function(value) { return originalScriptSrc.set.call(this, rewriteUrl(value)); }
        });
    }

    var originalLinkHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, 'href');
    if (originalLinkHref) {
        Object.defineProperty(HTMLLinkElement.prototype, 'href', {
            get: function() { return originalLinkHref.get.call(this); },
            set: function(value) { return originalLinkHref.set.call(this, rewriteUrl(value)); }
        });
    }

    function rewriteElement(node) {
        if (!node || node.nodeType !== 1) return;
        var tag = node.tagName;
        if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'SOURCE' || tag === 'VIDEO' || tag === 'AUDIO') {
            var src = node.getAttribute('src');
            if (src && src.charAt(0) === '/' && src.indexOf('/proxy/') !== 0) {
                node.setAttribute('src', '/proxy/' + opaqueId + src);
            }
        }
        if (tag === 'LINK' || tag === 'A') {
            var href = node.getAttribute('href');
            if (href && href.charAt(0) === '/' && href.indexOf('/proxy/') !== 0) {
                node.setAttribute('href', '/proxy/' + opaqueId + href);
            }
        }
        if (tag === 'FORM') {
            var action = node.getAttribute('action');
            if (action && action.charAt(0) === '/' && action.indexOf('/proxy/') !== 0) {
                node.setAttribute('action', '/proxy/' + opaqueId + action);
            }
        }
    }

    var originalPushState = history.pushState;
    history.pushState = function(state, title, url) {
        if (url) {
            var newUrl = rewriteUrl(url);
            return originalPushState.call(history, state, title, newUrl);
        }
        return originalPushState.call(history, state, title, url);
    };

    var originalReplaceState = history.replaceState;
    history.replaceState = function(state, title, url) {
        if (url) {
            var newUrl = rewriteUrl(url);
            return originalReplaceState.call(history, state, title, newUrl);
        }
        return originalReplaceState.call(history, state, title, url);
    };

    document.addEventListener('click', function(e) {
        var anchor = e.target.closest ? e.target.closest('a') : null;
        if (anchor && anchor.href) {
            var href = anchor.getAttribute('href');
            if (href && href.charAt(0) === '/' && href.indexOf('/proxy/') !== 0) {
                e.preventDefault();
                var newHref = '/proxy/' + opaqueId + href;
                window.location.href = newHref;
            }
        }
    }, true);

    var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
                if (node.nodeType === 1) {
                    rewriteElement(node);
                    if (node.querySelectorAll) {
                        node.querySelectorAll('img, script, link, a, iframe, form, source, video, audio').forEach(rewriteElement);
                    }
                }
            });
            if (mutation.type === 'attributes') {
                var attr = mutation.attributeName;
                if (attr === 'src' || attr === 'href' || attr === 'action') {
                    var val = mutation.target.getAttribute(attr);
                    if (val && val.charAt(0) === '/' && val.indexOf('/proxy/') !== 0) {
                        mutation.target.setAttribute(attr, '/proxy/' + opaqueId + val);
                    }
                }
            }
        });
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'action'] });
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'action'] });
        });
    }
})();
</script>
`;
}

// Rewrite HTML content
function rewriteHtml(body: string, parsedUrl: URL, opaqueId: string): string {
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  // Generate and inject intercept script
  const interceptScript = generateInterceptScript(opaqueId, parsedUrl.host, baseUrl);

  // Rewrite absolute URLs pointing to the target host
  body = body.replace(/(src|href|action)=(["'])((?:https?:)?\/\/[^"']*)/gi, (match, attr, quote, urlVal) => {
    if (urlVal.includes(parsedUrl.host)) {
      const pathMatch = urlVal.match(new RegExp(parsedUrl.host + '(.*)'));
      if (pathMatch) {
        return attr + '=' + quote + '/proxy/' + opaqueId + pathMatch[1];
      }
    }
    return match;
  });

  // Replace absolute paths with proxy paths
  body = body.replace(/(src|href|action)=(["'])\/((?!\/|proxy\/)[^"']*)/gi, (match, attr, quote, pathVal) => {
    return attr + '=' + quote + '/proxy/' + opaqueId + '/' + pathVal;
  });

  // Rewrite srcset attributes
  body = body.replace(/srcset=(["'])([^"']+)/gi, (match, quote, srcsetVal) => {
    const rewritten = srcsetVal.replace(/(\/?)((?!proxy\/)[^\s,]+)/g, (m: string, slash: string, path: string) => {
      if (path.startsWith('http') || path.startsWith('data:') || path.startsWith('//')) return m;
      if (slash === '/') return '/proxy/' + opaqueId + '/' + path;
      return m;
    });
    return 'srcset=' + quote + rewritten;
  });

  const baseTag = `<base href="/proxy/${opaqueId}/">`;

  if (body.match(/<head[^>]*>/i)) {
    body = body.replace(/<head[^>]*>/i, `$&\n${baseTag}\n${interceptScript}`);
  } else if (body.match(/<html[^>]*>/i)) {
    body = body.replace(/<html[^>]*>/i, `$&\n<head>${baseTag}\n${interceptScript}</head>`);
  } else {
    body = `${baseTag}\n${interceptScript}` + body;
  }

  // Remove X-Frame-Options meta tags
  body = body.replace(/<meta[^>]*x-frame-options[^>]*>/gi, '');

  // Remove frame-busting scripts
  body = body.replace(/if\s*\(\s*top\s*!==?\s*self\s*\)/gi, 'if(false)');
  body = body.replace(/if\s*\(\s*window\.top\s*!==?\s*window\.self\s*\)/gi, 'if(false)');
  body = body.replace(/if\s*\(\s*parent\s*!==?\s*window\s*\)/gi, 'if(false)');
  body = body.replace(/if\s*\(\s*window\s*!==?\s*window\.top\s*\)/gi, 'if(false)');

  return body;
}

// Rewrite CSS content
function rewriteCss(cssBody: string, opaqueId: string): string {
  // Rewrite url() with absolute paths
  cssBody = cssBody.replace(/url\s*\(\s*(['"]?)\/(?!\/|proxy\/)/gi, (match, quote) => {
    return 'url(' + quote + '/proxy/' + opaqueId + '/';
  });

  // Rewrite url() with relative paths (no leading slash)
  cssBody = cssBody.replace(/url\s*\(\s*(['"]?)(?!\/|data:|https?:|#|'|")/gi, (match, quote) => {
    return 'url(' + quote + '/proxy/' + opaqueId + '/';
  });

  return cssBody;
}

// Cookie storage per domain
const cookieStore = new Map<string, string[]>();

function parseCookies(setCookieHeaders: string[] | undefined, domain: string): void {
  if (!setCookieHeaders) return;
  const existing = cookieStore.get(domain) || [];
  setCookieHeaders.forEach(cookie => {
    const cookieName = cookie.split('=')[0];
    const filteredExisting = existing.filter(c => !c.startsWith(cookieName + '='));
    filteredExisting.push(cookie.split(';')[0]);
    cookieStore.set(domain, filteredExisting);
  });
}

function getCookieHeader(domain: string): string | undefined {
  const cookies = cookieStore.get(domain);
  return cookies ? cookies.join('; ') : undefined;
}

// Proxy request handler
async function proxyRequest(
  targetUrl: string,
  req: Request,
  res: Response,
  opaqueId: string,
  redirectCount = 0
): Promise<void> {
  // Prevent infinite redirects
  if (redirectCount > 10) {
    res.status(508).send('<html><body><h2>Too many redirects</h2></body></html>');
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    console.error('Invalid URL:', targetUrl);
    res.status(400).send('<html><body><h2>Invalid URL</h2></body></html>');
    return;
  }

  const protocol = parsedUrl.protocol === 'https:' ? https : http;
  const domain = parsedUrl.hostname;

  const options: http.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method || 'GET',
    headers: {
      'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Referer': `${parsedUrl.protocol}//${parsedUrl.host}/`,
      'Origin': `${parsedUrl.protocol}//${parsedUrl.host}`,
    },
    timeout: 60000,
  };

  // Forward content-type for POST requests
  if (req.headers['content-type']) {
    options.headers!['Content-Type'] = req.headers['content-type'];
  }

  // Add cookies if we have them
  const cookies = getCookieHeader(domain);
  if (cookies) {
    options.headers!['Cookie'] = cookies;
  }

  const proxyReq = protocol.request(options, (proxyRes) => {
    // Store any cookies from response
    const setCookieHeaders = proxyRes.headers['set-cookie'];
    if (setCookieHeaders) {
      parseCookies(setCookieHeaders, domain);
    }

    // Handle redirects
    if (proxyRes.statusCode && proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      let redirectUrl = proxyRes.headers.location;
      if (!redirectUrl.startsWith('http')) {
        if (redirectUrl.startsWith('/')) {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        } else {
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname.replace(/\/[^/]*$/, '/')}${redirectUrl}`;
        }
      }
      proxyRes.resume();
      proxyRequest(redirectUrl, req, res, opaqueId, redirectCount + 1);
      return;
    }

    const contentType = proxyRes.headers['content-type'] || 'text/html';

    // Modify HTML to fix relative URLs and route through proxy
    if (contentType.includes('text/html')) {
      let body = '';
      proxyRes.setEncoding('utf8');

      proxyRes.on('data', (chunk) => {
        body += chunk;
      });

      proxyRes.on('end', () => {
        if (res.headersSent) return;
        body = rewriteHtml(body, parsedUrl, opaqueId);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        res.send(body);
      });

      proxyRes.on('error', (err) => {
        console.error('Response stream error:', err);
        if (!res.headersSent) {
          res.status(502).send('<html><body><h2>Stream error</h2></body></html>');
        }
      });
    } else if (contentType.includes('text/css')) {
      // Rewrite URLs in CSS files
      let cssBody = '';
      proxyRes.setEncoding('utf8');

      proxyRes.on('data', (chunk) => {
        cssBody += chunk;
      });

      proxyRes.on('end', () => {
        if (res.headersSent) return;
        cssBody = rewriteCss(cssBody, opaqueId);
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(cssBody));
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(cssBody);
      });

      proxyRes.on('error', (err) => {
        console.error('CSS stream error:', err);
        if (!res.headersSent) {
          res.status(502).send('CSS stream error');
        }
      });
    } else {
      // For other content, pipe directly with CORS headers
      if (!res.headersSent) {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        if (proxyRes.headers['content-length']) {
          res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }

        res.status(proxyRes.statusCode || 200);
      }
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', targetUrl, err.message);
    if (!res.headersSent) {
      res.status(502).send(`
        <html>
        <body style="font-family: Arial; padding: 40px; text-align: center; background: #1a1a2e; color: white;">
            <h2>Unable to load content</h2>
            <p>The requested resource could not be fetched.</p>
        </body>
        </html>
      `);
    }
  });

  proxyReq.on('timeout', () => {
    console.error('Request timeout:', targetUrl);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).send(`
        <html>
        <body style="font-family: Arial; padding: 40px; text-align: center; background: #1a1a2e; color: white;">
            <h2>Request Timeout</h2>
            <p>The server took too long to respond.</p>
        </body>
        </html>
      `);
    }
  });

  // Forward POST body if present
  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// Validate session and get user ID
async function validateSession(req: Request, res: Response): Promise<string | null> {
  const prisma = req.app.get('prisma') as PrismaClient;
  const sessionService = new SessionService(prisma);

  const sessionToken = req.cookies?.proxy_session;
  if (!sessionToken) {
    res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    return null;
  }

  const session = await sessionService.validateSession(sessionToken);
  if (!session) {
    res.clearCookie('proxy_session');
    res.status(401).json({ error: 'Session expired', code: 'SESSION_EXPIRED' });
    return null;
  }

  if (session.forcePasswordChange) {
    res.status(403).json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
    return null;
  }

  return session.userId;
}

// Main proxy route - handles both initial request and sub-resources
router.all('/:opaqueId/*', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = await validateSession(req, res);
    if (!userId) return;

    const prisma = req.app.get('prisma') as PrismaClient;
    const proxyService = new ProxyService(prisma);
    const { opaqueId } = req.params;
    const subPath = req.params[0] || '';

    // Check cache first
    let targetInfo = targetUrlCache.get(opaqueId);

    if (!targetInfo) {
      // Validate access and get target URL
      const accessResult = await proxyService.validateAccess(userId, opaqueId);

      if (!accessResult.authorized || !accessResult.urlConfig) {
        return res.status(403).send(`
          <!DOCTYPE html>
          <html>
          <head><title>Access Denied</title></head>
          <body style="font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5;">
            <div style="text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h1 style="color: #dc2626;">Access Denied</h1>
              <p style="color: #666;">You do not have permission to access this resource.</p>
            </div>
          </body>
          </html>
        `);
      }

      const parsedTarget = new URL(accessResult.urlConfig.targetUrl);
      targetInfo = {
        targetUrl: accessResult.urlConfig.targetUrl,
        host: parsedTarget.host,
        protocol: parsedTarget.protocol,
      };

      // Cache for future sub-resource requests
      targetUrlCache.set(opaqueId, targetInfo);
    }

    // Build full target URL with sub-path
    const parsedBase = new URL(targetInfo.targetUrl);
    let fullTargetUrl: string;

    // Handle external domain requests (cross-domain API calls)
    if (subPath.startsWith('_ext/')) {
      const encodedUrl = subPath.substring(5); // Remove '_ext/' prefix
      try {
        // Decode base64url to original URL
        const base64 = encodedUrl.replace(/-/g, '+').replace(/_/g, '/');
        const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
        fullTargetUrl = Buffer.from(base64 + padding, 'base64').toString('utf8');

        // Validate the decoded URL belongs to same root domain
        const decodedUrl = new URL(fullTargetUrl);
        const targetRootDomain = getRootDomain(parsedBase.host);
        const requestRootDomain = getRootDomain(decodedUrl.host);

        if (targetRootDomain !== requestRootDomain) {
          console.error('Cross-domain request blocked:', fullTargetUrl, 'vs', parsedBase.host);
          return res.status(403).send('Cross-domain request not allowed');
        }
      } catch (e) {
        console.error('Failed to decode external URL:', encodedUrl, e);
        return res.status(400).send('Invalid external URL');
      }
    } else if (subPath) {
      // For sub-resources, append the path and query string to the base origin
      const queryString = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
      fullTargetUrl = `${parsedBase.protocol}//${parsedBase.host}/${subPath}${queryString}`;
    } else {
      fullTargetUrl = targetInfo.targetUrl;
    }

    await proxyRequest(fullTargetUrl, req, res, opaqueId);
  } catch (error) {
    console.error('Proxy error:', error);
    if (!res.headersSent) {
      res.status(500).send('<html><body><h2>Error</h2><p>An unexpected error occurred.</p></body></html>');
    }
  }
});

// Initial proxy route (no sub-path)
router.all('/:opaqueId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const startTime = Date.now();
    const userId = await validateSession(req, res);
    if (!userId) return;

    const prisma = req.app.get('prisma') as PrismaClient;
    const proxyService = new ProxyService(prisma);
    const auditLogService = new AuditLogService(prisma);
    const { opaqueId } = req.params;

    // Validate access
    const accessResult = await proxyService.validateAccess(userId, opaqueId);

    if (!accessResult.authorized || !accessResult.urlConfig) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Access Denied</title>
          <meta http-equiv="refresh" content="5;url=/dashboard">
        </head>
        <body style="font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5;">
          <div style="text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <h1 style="color: #dc2626;">Access Denied</h1>
            <p style="color: #666;">You do not have permission to access this resource.</p>
            <p style="color: #666;">Redirecting to dashboard in 5 seconds...</p>
          </div>
        </body>
        </html>
      `);
    }

    // Cache target URL for sub-resources
    const parsedTarget = new URL(accessResult.urlConfig.targetUrl);
    targetUrlCache.set(opaqueId, {
      targetUrl: accessResult.urlConfig.targetUrl,
      host: parsedTarget.host,
      protocol: parsedTarget.protocol,
    });

    // Log access
    const durationMs = Date.now() - startTime;
    auditLogService.logAccess({
      userId,
      userTypeId: accessResult.userTypeId!,
      projectTypeId: accessResult.projectTypeId!,
      urlConfigId: accessResult.urlConfig.id,
      targetUrl: accessResult.urlConfig.targetUrl,
      requestMethod: req.method,
      responseStatus: 200,
      durationMs,
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });

    await proxyRequest(accessResult.urlConfig.targetUrl, req, res, opaqueId);
  } catch (error) {
    console.error('Proxy error:', error);
    if (!res.headersSent) {
      res.status(500).send('<html><body><h2>Error</h2><p>An unexpected error occurred.</p></body></html>');
    }
  }
});

export default router;
