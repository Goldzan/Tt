/*
 * search.js — place lookup via OpenStreetMap's Nominatim geocoder.
 *
 * Lets you type "Mount Rainier" instead of hunting for 46.8523, -121.7603.
 *
 * Nominatim is a free service run for the community, and it has a usage policy
 * worth honouring: no autocomplete-style per-keystroke requests, at most one
 * request a second, and results cached rather than re-fetched. All three are
 * enforced here — the UI only ever calls query() on an explicit submit, and
 * this module throttles and caches on top of that.
 *
 * Browsers will not let a page set User-Agent, so the Referer header is what
 * identifies this tool to the service.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  var DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  var MIN_INTERVAL_MS = 1000; // Nominatim's published rate limit
  var LIMIT = 6;

  // What to frame when a result has no meaningful footprint — a summit, a
  // trig point, a named rock. A 10 km box around a peak is a map; the 100 m
  // box Nominatim reports for it is not.
  var POINT_DEFAULT_M = 10000;
  var POINT_THRESHOLD_M = 2000;

  var endpoint = DEFAULT_ENDPOINT;
  var cache = new Map();
  var lastRequestAt = 0;

  /** Point the search at a different Nominatim instance, or a local mirror. */
  function setEndpoint(url) {
    endpoint = url || DEFAULT_ENDPOINT;
    cache.clear();
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * Read a peak's height out of its `ele` tag.
   *
   * OSM's convention is plain metres, but the tag is free text and real data
   * carries "4392 m", "1,200", "ca. 2000" and worse. Since the value is only
   * ever shown as a hint beside the place name, pulling out the first number
   * is more useful than insisting on a clean parse. Commas are dropped as
   * thousands separators, which is how they are nearly always meant here.
   */
  function parseElevation(extratags) {
    if (!extratags || !extratags.ele) return null;
    var match = String(extratags.ele).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    var v = parseFloat(match[0]);
    return isFinite(v) ? v : null;
  }

  function toResult(raw) {
    var bbox = null;
    if (raw.boundingbox && raw.boundingbox.length === 4) {
      // Nominatim orders it [south, north, west, east], all as strings.
      var s = parseFloat(raw.boundingbox[0]);
      var n = parseFloat(raw.boundingbox[1]);
      var w = parseFloat(raw.boundingbox[2]);
      var e = parseFloat(raw.boundingbox[3]);
      if (isFinite(s) && isFinite(n) && isFinite(w) && isFinite(e)) {
        bbox = { south: s, north: n, west: w, east: e };
      }
    }

    var label = raw.display_name || raw.name || '';
    return {
      name: raw.name || label.split(',')[0],
      label: label,
      lat: parseFloat(raw.lat),
      lng: parseFloat(raw.lon),
      bbox: bbox,
      category: raw.category || raw.class || '',
      type: raw.type || '',
      ele: parseElevation(raw.extratags)
    };
  }

  /**
   * How wide a map to draw for a result, in metres.
   *
   * Areas are framed to their own extent with a little breathing room; points
   * get a fixed default, because their reported footprint says nothing about
   * how much terrain is worth looking at around them.
   */
  function widthForResult(result) {
    var el = Topo.elevation;
    var min = el.MIN_WIDTH_M;
    var max = el.MAX_WIDTH_M;

    if (!result || !result.bbox) return POINT_DEFAULT_M;

    var b = result.bbox;
    var midLat = (b.south + b.north) / 2;
    var ground = el.haversine(midLat, b.west, midLat, b.east);

    if (!isFinite(ground) || ground < POINT_THRESHOLD_M) return POINT_DEFAULT_M;
    return Math.max(min, Math.min(max, ground * 1.2));
  }

  function buildUrl(text) {
    return (
      endpoint +
      '?q=' + encodeURIComponent(text) +
      '&format=jsonv2' +
      '&limit=' + LIMIT +
      '&extratags=1'
    );
  }

  /**
   * Look a place up. Resolves to an array of results, empty if nothing matched.
   * Repeat queries are served from the session cache without a request.
   */
  function query(text, options) {
    options = options || {};
    var trimmed = String(text || '').trim();
    if (!trimmed) return Promise.resolve([]);

    var key = trimmed.toLowerCase();
    if (cache.has(key)) return Promise.resolve(cache.get(key));

    var wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));

    return delay(wait)
      .then(function () {
        lastRequestAt = Date.now();
        return fetch(buildUrl(trimmed), {
          signal: options.signal,
          headers: { Accept: 'application/json' }
        });
      })
      .then(function (res) {
        if (res.status === 429) {
          throw new Error(
            'OpenStreetMap search is rate-limiting this browser. Wait a moment and try again.'
          );
        }
        if (!res.ok) throw new Error('Place search failed (HTTP ' + res.status + ').');
        return res.json();
      })
      .then(function (raw) {
        var results = (Array.isArray(raw) ? raw : []).map(toResult).filter(function (r) {
          return isFinite(r.lat) && isFinite(r.lng);
        });
        cache.set(key, results);
        return results;
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw err;
        if (err instanceof TypeError) {
          throw new Error(
            'Could not reach OpenStreetMap search. Check your network connection, ' +
              'or type coordinates directly.'
          );
        }
        throw err;
      });
  }

  Topo.search = {
    query: query,
    setEndpoint: setEndpoint,
    widthForResult: widthForResult,
    toResult: toResult,
    buildUrl: buildUrl,
    MIN_INTERVAL_MS: MIN_INTERVAL_MS,
    POINT_DEFAULT_M: POINT_DEFAULT_M,
    clearCache: function () { cache.clear(); }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.search;
})(typeof globalThis !== 'undefined' ? globalThis : this);
