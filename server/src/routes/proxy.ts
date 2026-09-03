import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ProxyMode } from '@prisma/client';
import { setSessionCookie } from '../middleware/auth.js';
import { SessionService } from '../services/sessionService.js';
import { ProxyService } from '../services/proxyService.js';
import { AuditLogService } from '../services/auditLogService.js';
import { getHeadlessManager } from '../services/headlessManager.js';
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

    // Intercept window.location assignments
    var originalAssign = window.location.assign;
    window.location.assign = function(url) {
        var newUrl = rewriteUrl(url);
        console.log('[Proxy] location.assign:', url, '->', newUrl);
        return originalAssign.call(window.location, newUrl);
    };

    var originalReplace = window.location.replace;
    window.location.replace = function(url) {
        var newUrl = rewriteUrl(url);
        console.log('[Proxy] location.replace:', url, '->', newUrl);
        return originalReplace.call(window.location, newUrl);
    };

    // Try to intercept window.location.href setter
    // Note: This may not work in all browsers but helps in many cases
    try {
        var locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
        if (locationDescriptor && locationDescriptor.configurable !== false) {
            // Create a proxy for location object
            var originalLocation = window.location;
            var locationProxy = new Proxy(originalLocation, {
                set: function(target, prop, value) {
                    if (prop === 'href') {
                        var newUrl = rewriteUrl(value);
                        console.log('[Proxy] location.href =', value, '->', newUrl);
                        target.href = newUrl;
                        return true;
                    }
                    target[prop] = value;
                    return true;
                },
                get: function(target, prop) {
                    var value = target[prop];
                    if (typeof value === 'function') {
                        return value.bind(target);
                    }
                    return value;
                }
            });
            // This assignment may fail in strict mode or certain browsers
            // window.location = locationProxy;
        }
    } catch(e) {
        console.log('[Proxy] Could not override location object:', e);
    }

    // Override document.location as well
    try {
        var docLocationDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'location');
        if (docLocationDescriptor && docLocationDescriptor.set) {
            var originalDocLocationSet = docLocationDescriptor.set;
            Object.defineProperty(Document.prototype, 'location', {
                get: docLocationDescriptor.get,
                set: function(value) {
                    var newUrl = rewriteUrl(value);
                    console.log('[Proxy] document.location =', value, '->', newUrl);
                    originalDocLocationSet.call(this, newUrl);
                },
                configurable: true
            });
        }
    } catch(e) {
        console.log('[Proxy] Could not override document.location:', e);
    }

    document.addEventListener('click', function(e) {
        var anchor = e.target.closest ? e.target.closest('a') : null;
        if (anchor && anchor.href) {
            var href = anchor.getAttribute('href');
            if (href && href.charAt(0) === '/' && href.indexOf('/proxy/') !== 0) {
                e.preventDefault();
                var newHref = '/proxy/' + opaqueId + href;
                originalAssign.call(window.location, newHref);
            }
        }
    }, true);

    // Intercept form submissions to ensure action URLs are rewritten
    document.addEventListener('submit', function(e) {
        var form = e.target;
        if (form && form.tagName === 'FORM') {
            var action = form.getAttribute('action') || '';
            if (action && action.indexOf('/proxy/') !== 0) {
                var newAction = rewriteUrl(action);
                console.log('[Proxy] form submit action:', action, '->', newAction);
                form.setAttribute('action', newAction);
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

  // Get the directory path for resolving relative URLs
  const currentPath = parsedUrl.pathname;
  const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);

  // Generate and inject intercept script
  const interceptScript = generateInterceptScript(opaqueId, parsedUrl.host, baseUrl);

  // Rewrite absolute URLs pointing to the target host
  body = body.replace(/(src|href|action)=(["'])((?:https?:)?\/\/[^"']*)/gi, (_match, attr, quote, urlVal) => {
    if (urlVal.includes(parsedUrl.host)) {
      const pathMatch = urlVal.match(new RegExp(parsedUrl.host + '(.*)'));
      if (pathMatch) {
        return attr + '=' + quote + '/proxy/' + opaqueId + pathMatch[1];
      }
    }
    return _match;
  });

  // Replace absolute paths with proxy paths
  body = body.replace(/(src|href|action)=(["'])\/((?!\/|proxy\/)[^"']*)/gi, (_match, attr, quote, pathVal) => {
    return attr + '=' + quote + '/proxy/' + opaqueId + '/' + pathVal;
  });

  // Rewrite relative paths with ../ to absolute proxy paths
  body = body.replace(/(src|href|action)=(["'])(\.\.\/[^"']*)/gi, (_match, attr, quote, relPath) => {
    // Resolve the relative path against current directory
    let resolvedPath = currentDir;
    let remainingPath = relPath;

    while (remainingPath.startsWith('../')) {
      remainingPath = remainingPath.substring(3);
      resolvedPath = resolvedPath.substring(0, resolvedPath.lastIndexOf('/', resolvedPath.length - 2) + 1);
    }
    resolvedPath = resolvedPath + remainingPath;

    return attr + '=' + quote + '/proxy/' + opaqueId + resolvedPath;
  });

  // Rewrite relative paths with ./ to absolute proxy paths
  body = body.replace(/(src|href|action)=(["'])(\.\/[^"']*)/gi, (_match, attr, quote, relPath) => {
    const resolvedPath = currentDir + relPath.substring(2);
    return attr + '=' + quote + '/proxy/' + opaqueId + resolvedPath;
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

  // Use the current directory as base to correctly resolve relative paths
  const baseTag = `<base href="/proxy/${opaqueId}${currentDir}">`;

  if (body.match(/<head[^>]*>/i)) {
    body = body.replace(/<head[^>]*>/i, `$&\n${baseTag}\n${interceptScript}`);
  } else if (body.match(/<html[^>]*>/i)) {
    body = body.replace(/<html[^>]*>/i, `$&\n<head>${baseTag}\n${interceptScript}</head>`);
  } else {
    body = `${baseTag}\n${interceptScript}` + body;
  }

  // Remove X-Frame-Options meta tags
  body = body.replace(/<meta[^>]*x-frame-options[^>]*>/gi, '');

  // Rewrite meta refresh tags
  body = body.replace(/<meta\s+http-equiv=["']refresh["'][^>]*content=["'](\d+);?\s*url=([^"']+)["'][^>]*>/gi,
    (_match, seconds, url) => {
      const newUrl = url.startsWith('/') && !url.startsWith('/proxy/')
        ? `/proxy/${opaqueId}${url}`
        : url;
      return `<meta http-equiv="refresh" content="${seconds};url=${newUrl}">`;
    }
  );

  // Also handle meta refresh with content before http-equiv
  body = body.replace(/<meta\s+content=["'](\d+);?\s*url=([^"']+)["'][^>]*http-equiv=["']refresh["'][^>]*>/gi,
    (_match, seconds, url) => {
      const newUrl = url.startsWith('/') && !url.startsWith('/proxy/')
        ? `/proxy/${opaqueId}${url}`
        : url;
      return `<meta http-equiv="refresh" content="${seconds};url=${newUrl}">`;
    }
  );

  // Rewrite inline JavaScript window.location assignments
  // This handles common patterns like: window.location.href = '/path' or window.location = '/path'
  body = body.replace(/window\.location(\.href)?\s*=\s*(['"])\/(?!proxy\/)/gi,
    `window.location$1 = $2/proxy/${opaqueId}/`
  );

  // Rewrite document.location assignments
  body = body.replace(/document\.location(\.href)?\s*=\s*(['"])\/(?!proxy\/)/gi,
    `document.location$1 = $2/proxy/${opaqueId}/`
  );

  // Rewrite location.href = '/path' (without window prefix)
  body = body.replace(/([^.])\blocation(\.href)?\s*=\s*(['"])\/(?!proxy\/)/gi,
    `$1location$2 = $3/proxy/${opaqueId}/`
  );

  // Remove frame-busting scripts
  body = body.replace(/if\s*\(\s*top\s*!==?\s*self\s*\)/gi, 'if(false)');
  body = body.replace(/if\s*\(\s*window\.top\s*!==?\s*window\.self\s*\)/gi, 'if(false)');
  body = body.replace(/if\s*\(\s*parent\s*!==?\s*window\s*\)/gi, 'if(false)');
  body = body.replace(/if\s*\(\s*window\s*!==?\s*window\.top\s*\)/gi, 'if(false)');

  return body;
}

// Rewrite CSS content
function rewriteCss(cssBody: string, opaqueId: string, cssFilePath: string): string {
  // Get the directory of the CSS file for resolving relative paths
  const cssDir = cssFilePath.substring(0, cssFilePath.lastIndexOf('/') + 1);

  // Rewrite url() with absolute paths (starting with /)
  cssBody = cssBody.replace(/url\s*\(\s*(['"]?)\/(?!\/|proxy\/)/gi, (_match, quote) => {
    return 'url(' + quote + '/proxy/' + opaqueId + '/';
  });

  // Rewrite url() with ../ relative paths
  cssBody = cssBody.replace(/url\s*\(\s*(['"]?)(\.\.\/[^)'"]+)/gi, (_match, quote, relPath) => {
    // Resolve the relative path against CSS directory
    let resolvedPath = cssDir;
    let remainingPath = relPath;

    while (remainingPath.startsWith('../')) {
      remainingPath = remainingPath.substring(3);
      resolvedPath = resolvedPath.substring(0, resolvedPath.lastIndexOf('/', resolvedPath.length - 2) + 1);
    }
    resolvedPath = resolvedPath + remainingPath;

    return 'url(' + quote + '/proxy/' + opaqueId + resolvedPath;
  });

  // Rewrite url() with ./ relative paths
  cssBody = cssBody.replace(/url\s*\(\s*(['"]?)(\.\/[^)'"]+)/gi, (_match, quote, relPath) => {
    const resolvedPath = cssDir + relPath.substring(2);
    return 'url(' + quote + '/proxy/' + opaqueId + resolvedPath;
  });

  // Rewrite url() with simple relative paths (no leading slash, ./, or ../)
  cssBody = cssBody.replace(/url\s*\(\s*(['"]?)(?!\/|data:|https?:|#|'|"|\.\.\/|\.\/|\))/gi, (_match, quote) => {
    return 'url(' + quote + '/proxy/' + opaqueId + cssDir;
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

// Store cookies from headless session for use by direct proxy sub-resource requests
function storeHeadlessCookies(cookies: Array<{ name: string; value: string; domain: string; path: string }>): void {
  for (const cookie of cookies) {
    // Normalize domain (remove leading dot)
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const existing = cookieStore.get(domain) || [];
    const cookieStr = `${cookie.name}=${cookie.value}`;

    // Remove old cookie with same name
    const filtered = existing.filter(c => !c.startsWith(cookie.name + '='));
    filtered.push(cookieStr);
    cookieStore.set(domain, filtered);
  }
  console.log(`[Proxy] Stored ${cookies.length} cookies from headless session`);
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

  // Determine resource type based on file extension for proper headers
  const pathLower = parsedUrl.pathname.toLowerCase();
  const isCSS = pathLower.endsWith('.css');
  const isJS = pathLower.endsWith('.js');
  const isImage = /\.(png|jpg|jpeg|gif|ico|svg|webp|bmp)$/i.test(pathLower);
  const isFont = /\.(woff|woff2|ttf|eot|otf)$/i.test(pathLower);
  const isDocument = !isCSS && !isJS && !isImage && !isFont;

  // Set appropriate Accept and Sec-Fetch headers based on resource type
  let acceptHeader = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
  let secFetchDest = 'document';
  let secFetchMode = 'navigate';

  if (isCSS) {
    acceptHeader = 'text/css,*/*;q=0.1';
    secFetchDest = 'style';
    secFetchMode = 'no-cors';
  } else if (isJS) {
    acceptHeader = '*/*';
    secFetchDest = 'script';
    secFetchMode = 'no-cors';
  } else if (isImage) {
    acceptHeader = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
    secFetchDest = 'image';
    secFetchMode = 'no-cors';
  } else if (isFont) {
    acceptHeader = '*/*';
    secFetchDest = 'font';
    secFetchMode = 'cors';
  }

  const options: http.RequestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: req.method || 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': acceptHeader,
      'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': secFetchDest,
      'Sec-Fetch-Mode': secFetchMode,
      'Sec-Fetch-Site': 'same-origin',
      'Referer': `${parsedUrl.protocol}//${parsedUrl.host}/`,
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

    // Strip security headers that prevent iframe embedding
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['content-security-policy-report-only'];
    delete proxyRes.headers['x-content-security-policy'];
    delete proxyRes.headers['x-webkit-csp'];

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
        cssBody = rewriteCss(cssBody, opaqueId, parsedUrl.pathname);
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

  // Slide the cookie, exactly as authMiddleware does. This path has its own validator, so a
  // user working only inside the proxied iframe refreshed lastActivity server-side while the
  // cookie kept its original expiry — and was signed out mid-session despite never pausing.
  setSessionCookie(res, sessionToken);

  if (session.forcePasswordChange) {
    res.status(403).json({ error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' });
    return null;
  }

  return session.userId;
}

// Main proxy route - handles both initial request and sub-resources
// These two are declared BEFORE the catch-all below, and must stay there. `/:opaqueId/*`
// happily matches /proxy/redirect/<id> with opaqueId="redirect" and /proxy/health/headless
// with opaqueId="health", so declared after it they were dead: the health check answered
// SESSION_EXPIRED instead of a health status, and the NEW_WINDOW redirect resolved as a
// proxy request for a URL config that does not exist. Same trap the claims router
// documents for its bulk/* routes.

// Redirect endpoint for NEW_WINDOW mode (logs access then redirects)
router.get('/redirect/:opaqueId', async (req: Request, res: Response) => {
  try {
    const userId = await validateSession(req, res);
    if (!userId) return;

    const prisma = req.app.get('prisma') as PrismaClient;
    const proxyService = new ProxyService(prisma);
    const auditLogService = new AuditLogService(prisma);
    const { opaqueId } = req.params;

    // Validate access
    const accessResult = await proxyService.validateAccess(userId, opaqueId);

    if (!accessResult.authorized || !accessResult.urlConfig) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Log the redirect access
    auditLogService.logAccess({
      userId,
      projectId: accessResult.projectId!,
      urlConfigId: accessResult.urlConfig.id,
      targetUrl: accessResult.urlConfig.targetUrl,
      requestMethod: 'GET',
      responseStatus: 302,
      durationMs: 0,
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });

    // Redirect to actual target URL
    res.redirect(302, accessResult.urlConfig.targetUrl);
  } catch (error) {
    console.error('Redirect error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
});


// Health check endpoint for headless manager
router.get('/health/headless', async (_req: Request, res: Response) => {
  try {
    const headlessManager = getHeadlessManager();
    const metrics = headlessManager.getMetrics();

    const status = metrics.queueLength >= metrics.queueMaxSize
      ? 'degraded'
      : metrics.activeSessions >= metrics.maxSessions
        ? 'busy'
        : 'healthy';

    res.json({
      status,
      ...metrics
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

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

    // Get proxy mode from URL configuration
    const proxyMode = accessResult.urlConfig.proxyMode || ProxyMode.DIRECT;

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
      projectId: accessResult.projectId!,
      urlConfigId: accessResult.urlConfig.id,
      targetUrl: accessResult.urlConfig.targetUrl,
      requestMethod: req.method,
      responseStatus: 200,
      durationMs,
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    });

    // Route based on proxy mode
    switch (proxyMode) {
      case ProxyMode.HEADLESS:
        await handleHeadlessProxy(
          accessResult.urlConfig.targetUrl,
          req,
          res,
          opaqueId,
          userId,
          accessResult.urlConfig.headlessTimeout
        );
        break;

      case ProxyMode.NEW_WINDOW:
        // Return redirect response for client to open in new window
        res.json({
          mode: 'NEW_WINDOW',
          redirectUrl: `/redirect/${opaqueId}`,
          message: 'This URL is configured to open in a new window'
        });
        break;

      case ProxyMode.DIRECT:
      default:
        await proxyRequest(accessResult.urlConfig.targetUrl, req, res, opaqueId);
        break;
    }
  } catch (error) {
    console.error('Proxy error:', error);
    if (!res.headersSent) {
      res.status(500).send('<html><body><h2>Error</h2><p>An unexpected error occurred.</p></body></html>');
    }
  }
});

// Headless proxy handler
async function handleHeadlessProxy(
  targetUrl: string,
  req: Request,
  res: Response,
  opaqueId: string,
  userId: string,
  headlessTimeout?: number
): Promise<void> {
  try {
    const headlessManager = getHeadlessManager();

    // Show loading state while browser spawns
    console.log(`[Proxy] Starting headless session for ${opaqueId}`);

    // Acquire headless session
    const session = await headlessManager.acquireSession(
      opaqueId,
      targetUrl,
      userId,
      headlessTimeout
    );

    // Load the page
    const result = await session.loadPage();

    if (!result.success) {
      // Release session on failure
      await headlessManager.releaseSession(session.id);

      res.status(502).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Unable to Load</title></head>
        <body style="font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
          <div style="text-align: center; padding: 40px;">
            <h2>Unable to load content</h2>
            <p>${result.error || 'The page could not be loaded through headless browser.'}</p>
            <button onclick="window.location.reload()" style="margin-top: 20px; padding: 10px 24px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Retry
            </button>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Store cookies from headless session for use by sub-resource requests
    if (result.cookies && result.cookies.length > 0) {
      storeHeadlessCookies(result.cookies);
    }

    // Rewrite URLs in the HTML so sub-resources go through the proxy
    const finalUrl = result.url || targetUrl;
    const parsedUrl = new URL(finalUrl);
    let rewrittenHtml = rewriteHtml(result.html || '', parsedUrl, opaqueId);

    // Then wrap with headless indicator
    const wrappedHtml = wrapHeadlessContent(rewrittenHtml, opaqueId, session.id);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Proxy-Mode', 'HEADLESS');
    res.setHeader('X-Headless-Session', session.id);
    res.send(wrappedHtml);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Proxy] Headless error:', errorMessage);

    if (!res.headersSent) {
      // Check if queue is full
      const isQueueFull = errorMessage.includes('queue is full');

      res.status(503).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Service Temporarily Unavailable</title></head>
        <body style="font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
          <div style="text-align: center; padding: 40px;">
            <h2>${isQueueFull ? 'Server is busy' : 'Unable to load content'}</h2>
            <p>${isQueueFull ? 'Too many requests. Please try again in a moment.' : errorMessage}</p>
            <button onclick="window.location.reload()" style="margin-top: 20px; padding: 10px 24px; background: #4f46e5; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Retry
            </button>
          </div>
        </body>
        </html>
      `);
    }
  }
}

// Wrap headless content (no visual indicator, just pass through)
function wrapHeadlessContent(html: string, _opaqueId: string, _sessionId: string): string {
  // Return HTML as-is without any visual modifications
  return html;
}


export default router;
