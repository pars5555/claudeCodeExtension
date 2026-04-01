/**
 * AI Web Assistant - Page Data Collector
 * Content script utility for collecting page metadata and diagnostics.
 * Injected alongside dom-inspector.js into web pages.
 */
(function () {
  'use strict';

  if (window.WebAIPageDataCollector) {
    return;
  }

  /**
   * Truncate a string to maxLen characters, appending an indicator if trimmed.
   */
  function truncate(value, maxLen) {
    if (typeof value !== 'string') {
      value = String(value);
    }
    if (value.length > maxLen) {
      return value.slice(0, maxLen) + '...[truncated]';
    }
    return value;
  }

  /**
   * Safely execute a function, returning fallback on error.
   */
  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_e) {
      return fallback;
    }
  }

  var MAX_STORAGE_ENTRIES = 50;
  var MAX_VALUE_LENGTH = 500;
  var MAX_RESOURCES = 30;
  var MAX_SOURCES_EACH = 50;

  window.WebAIPageDataCollector = {

    /**
     * Parse document.cookie into an array of {name, value} objects.
     * Note: HttpOnly cookies are not visible here.
     */
    getCookiesSummary: function () {
      return safe(function () {
        var raw = document.cookie;
        if (!raw || !raw.trim()) {
          return [];
        }
        return raw.split(';').map(function (pair) {
          var idx = pair.indexOf('=');
          if (idx === -1) {
            return { name: pair.trim(), value: '' };
          }
          return {
            name: pair.slice(0, idx).trim(),
            value: pair.slice(idx + 1).trim()
          };
        }).filter(function (c) {
          return c.name.length > 0;
        });
      }, []);
    },

    /**
     * Return all localStorage entries as an object (max 50, values truncated at 500 chars).
     */
    getLocalStorage: function () {
      return safe(function () {
        var result = {};
        var storage = window.localStorage;
        var count = Math.min(storage.length, MAX_STORAGE_ENTRIES);
        for (var i = 0; i < count; i++) {
          var key = storage.key(i);
          if (key !== null) {
            result[key] = truncate(storage.getItem(key) || '', MAX_VALUE_LENGTH);
          }
        }
        return result;
      }, {});
    },

    /**
     * Return all sessionStorage entries as an object (max 50, values truncated at 500 chars).
     */
    getSessionStorage: function () {
      return safe(function () {
        var result = {};
        var storage = window.sessionStorage;
        var count = Math.min(storage.length, MAX_STORAGE_ENTRIES);
        for (var i = 0; i < count; i++) {
          var key = storage.key(i);
          if (key !== null) {
            result[key] = truncate(storage.getItem(key) || '', MAX_VALUE_LENGTH);
          }
        }
        return result;
      }, {});
    },

    /**
     * Collect performance timing, resource entries, and memory info via the Performance API.
     */
    getPerformanceData: function () {
      return safe(function () {
        var perf = window.performance;
        if (!perf) {
          return { timing: {}, resources: [], memory: null };
        }

        // Timing
        var timing = {};
        try {
          var navEntries = perf.getEntriesByType('navigation');
          if (navEntries && navEntries.length > 0) {
            var nav = navEntries[0];
            timing.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
            timing.loadComplete = Math.round(nav.loadEventEnd);
          } else if (perf.timing) {
            var t = perf.timing;
            timing.domContentLoaded = t.domContentLoadedEventEnd - t.navigationStart;
            timing.loadComplete = t.loadEventEnd - t.navigationStart;
          }
        } catch (_e) { /* ignore */ }

        try {
          var paintEntries = perf.getEntriesByType('paint');
          if (paintEntries) {
            for (var i = 0; i < paintEntries.length; i++) {
              if (paintEntries[i].name === 'first-paint') {
                timing.firstPaint = Math.round(paintEntries[i].startTime);
              }
              if (paintEntries[i].name === 'first-contentful-paint') {
                timing.firstContentfulPaint = Math.round(paintEntries[i].startTime);
              }
            }
          }
        } catch (_e) { /* ignore */ }

        // Resources
        var resources = [];
        try {
          var resEntries = perf.getEntriesByType('resource');
          var limit = Math.min(resEntries.length, MAX_RESOURCES);
          for (var j = 0; j < limit; j++) {
            var r = resEntries[j];
            resources.push({
              name: truncate(r.name, 200),
              type: r.initiatorType || '',
              duration: Math.round(r.duration),
              size: r.transferSize || 0
            });
          }
        } catch (_e) { /* ignore */ }

        // Memory
        var memory = null;
        try {
          if (perf.memory) {
            memory = {
              jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
              totalJSHeapSize: perf.memory.totalJSHeapSize,
              usedJSHeapSize: perf.memory.usedJSHeapSize
            };
          }
        } catch (_e) { /* ignore */ }

        return { timing: timing, resources: resources, memory: memory };
      }, { timing: {}, resources: [], memory: null });
    },

    /**
     * Return network connection info from the Network Information API.
     */
    getNetworkInfo: function () {
      return safe(function () {
        var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!conn) {
          return { type: null, effectiveType: null, downlink: null, rtt: null };
        }
        return {
          type: conn.type || null,
          effectiveType: conn.effectiveType || null,
          downlink: typeof conn.downlink === 'number' ? conn.downlink : null,
          rtt: typeof conn.rtt === 'number' ? conn.rtt : null
        };
      }, { type: null, effectiveType: null, downlink: null, rtt: null });
    },

    /**
     * Enumerate script, stylesheet, and image sources present on the page.
     */
    getPageSources: function () {
      return safe(function () {
        var scripts = [];
        var stylesheets = [];
        var images = [];

        // Scripts
        var scriptEls = document.querySelectorAll('script[src]');
        var scriptLimit = Math.min(scriptEls.length, MAX_SOURCES_EACH);
        for (var i = 0; i < scriptLimit; i++) {
          var s = scriptEls[i];
          scripts.push({
            src: s.src,
            type: s.type || '',
            async: s.async,
            defer: s.defer
          });
        }

        // Stylesheets
        var linkEls = document.querySelectorAll('link[rel="stylesheet"][href]');
        var linkLimit = Math.min(linkEls.length, MAX_SOURCES_EACH);
        for (var j = 0; j < linkLimit; j++) {
          var l = linkEls[j];
          stylesheets.push({
            href: l.href,
            media: l.media || ''
          });
        }

        // Images
        var imgEls = document.querySelectorAll('img[src]');
        var imgLimit = Math.min(imgEls.length, MAX_SOURCES_EACH);
        for (var k = 0; k < imgLimit; k++) {
          var img = imgEls[k];
          images.push({
            src: img.src,
            alt: img.alt || '',
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0
          });
        }

        return { scripts: scripts, stylesheets: stylesheets, images: images };
      }, { scripts: [], stylesheets: [], images: [] });
    },

    /**
     * Return basic security-related information about the current page.
     */
    getSecurityInfo: function () {
      return safe(function () {
        var csp = '';
        var cspMeta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        if (cspMeta) {
          csp = cspMeta.getAttribute('content') || '';
        }

        var referrerPolicy = '';
        var rpMeta = document.querySelector('meta[name="referrer"]');
        if (rpMeta) {
          referrerPolicy = rpMeta.getAttribute('content') || '';
        }
        if (!referrerPolicy) {
          referrerPolicy = document.referrer ? 'has-referrer' : '';
        }

        return {
          protocol: location.protocol,
          isSecure: location.protocol === 'https:',
          csp: csp,
          referrerPolicy: referrerPolicy
        };
      }, { protocol: location.protocol, isSecure: false, csp: '', referrerPolicy: '' });
    }
  };
})();
