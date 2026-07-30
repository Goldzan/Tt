/*
 * elevation.js — free, key-less elevation data.
 *
 * Terrain comes from the AWS "Terrain Tiles" public dataset (Mapzen terrarium
 * encoding), which is open data, needs no account, and serves
 * `Access-Control-Allow-Origin: *` so the browser can read the pixels back off
 * a canvas. That is what lets this whole tool run with no backend.
 *
 *   elevation_metres = (R * 256 + G + B / 256) - 32768
 *
 * The pure math and decoding here are kept free of DOM references so the same
 * file can be require()d from Node for the unit tests; only fetchTile touches
 * the browser.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  var TILE_SIZE = 256;
  var MAX_ZOOM = 15; // terrarium coverage tops out here
  var MAX_TILES = 144; // sanity guard; real requests land well under this

  // The shop's frame: 4:3 landscape, so every map it sells is the same shape.
  // It is the default rather than the rule, because the standalone tool lets
  // the picture be any shape and the ground has to follow the picture.
  var ASPECT = 4 / 3;

  // How far from square a frame may go. Past these the box is a slit: one side
  // is sampled so much finer than the other that the contours stop meaning
  // anything, and the tile count for the long side climbs fast.
  var MIN_ASPECT = 0.25;
  var MAX_ASPECT = 4;

  // Web Mercator is defined on the equatorial sphere; haversine below uses the
  // mean radius because it is measuring real ground distance, not projecting.
  var EQUATORIAL_CIRCUMFERENCE = 2 * Math.PI * 6378137;

  var MIN_WIDTH_M = 500;
  var MAX_WIDTH_M = 200000;
  var TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

  var ATTRIBUTION =
    'Elevation: AWS Terrain Tiles (Mapzen terrarium) — SRTM, USGS 3DEP, ' +
    'GMTED2010, ETOPO1, NRCAN CDEM, and other public sources.';

  /* ---------------------------------------------------------------- mercator */

  function lonToWorldX(lon) {
    return (lon + 180) / 360;
  }

  function latToWorldY(lat) {
    var phi = (lat * Math.PI) / 180;
    return (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  }

  function worldXToLon(x) {
    return x * 360 - 180;
  }

  function worldYToLat(y) {
    var n = Math.PI * (1 - 2 * y);
    return (180 / Math.PI) * Math.atan(Math.sinh(n));
  }

  /* Great-circle distance in metres, for the "box is N km across" readout. */
  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371008.8;
    var p = Math.PI / 180;
    var dLat = (lat2 - lat1) * p;
    var dLon = (lon2 - lon1) * p;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /* ------------------------------------------------------------------- bbox */

  /**
   * Build the bounding box around a centre point.
   *
   * The box is exactly `aspect` in *projected* space, which is what the output
   * frame is — so the ground in the box and the picture drawn from it are the
   * same shape. Over a very tall box at high latitude the ground-distance
   * height will not be exactly width/aspect, because Mercator scale grows with
   * latitude; that is the projection behaving correctly, and the readout shows
   * the true ground dimensions either way.
   *
   * widthMetres is measured across the centre latitude. Omitting aspect gives
   * the shop's 4:3, which is what every caller but the standalone tool wants.
   */
  function bboxFromCentre(centre, widthMetres, aspect) {
    if (!centre) throw new Error('Pick a centre point on the map first.');
    if (!isFinite(centre.lat) || !isFinite(centre.lng)) {
      throw new Error('Coordinates must be numbers.');
    }
    if (Math.abs(centre.lat) > 85.0511) {
      throw new Error('Latitude must stay within ±85.05° (Web Mercator limit).');
    }
    if (!isFinite(widthMetres) || widthMetres < MIN_WIDTH_M || widthMetres > MAX_WIDTH_M) {
      throw new Error(
        'Map width must be between ' +
          MIN_WIDTH_M / 1000 +
          ' km and ' +
          MAX_WIDTH_M / 1000 +
          ' km.'
      );
    }

    aspect = aspect === undefined ? ASPECT : aspect;
    if (!isFinite(aspect) || aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
      throw new Error(
        'Frame shape must be between ' + MIN_ASPECT + ' and ' + MAX_ASPECT +
          ' (width ÷ height).'
      );
    }

    // World-X is the whole globe over one unit, so a metre spans
    // 1 / (circumference · cos φ) of it at latitude φ.
    var spanX = widthMetres / (EQUATORIAL_CIRCUMFERENCE * Math.cos((centre.lat * Math.PI) / 180));
    var spanY = spanX / aspect;

    if (spanX >= 0.5) {
      throw new Error('That width covers half the globe. Pick a narrower map.');
    }

    var xc = lonToWorldX(centre.lng);
    var yc = latToWorldY(centre.lat);

    if (yc - spanY / 2 <= 0 || yc + spanY / 2 >= 1) {
      throw new Error('That box runs off the top or bottom of the map. Move south, or narrow it.');
    }

    return {
      south: worldYToLat(yc + spanY / 2),
      west: worldXToLon(xc - spanX / 2),
      north: worldYToLat(yc - spanY / 2),
      east: worldXToLon(xc + spanX / 2),
      centre: { lat: centre.lat, lng: centre.lng },
      widthMetres: widthMetres,
      aspect: aspect
    };
  }

  /* ------------------------------------------------------------------- plan */

  /**
   * Work out the zoom level, grid dimensions and tile range for a request,
   * without fetching anything. The UI calls this on every slider move so it can
   * show the cost up front.
   *
   * targetWidth is the requested number of grid samples across the box.
   */
  function planGrid(bbox, targetWidth) {
    var x0 = lonToWorldX(bbox.west);
    var x1 = lonToWorldX(bbox.east);
    var y0 = latToWorldY(bbox.north); // north is the smaller world-Y
    var y1 = latToWorldY(bbox.south);

    var spanX = x1 - x0;
    var spanY = y1 - y0;

    // One grid sample per source pixel, or coarser — never finer than the data.
    var zoom = Math.ceil(Math.log2(targetWidth / (spanX * TILE_SIZE)));
    zoom = Math.max(0, Math.min(MAX_ZOOM, zoom));

    var scale = Math.pow(2, zoom) * TILE_SIZE; // world pixels across the globe

    // Grid resolution is capped by what the data can actually deliver, so a
    // high detail setting over a huge area doesn't invent precision.
    var width = Math.max(2, Math.min(targetWidth, Math.round(spanX * scale)));
    var height = Math.max(2, Math.round((width * spanY) / spanX));

    var n = Math.pow(2, zoom);
    var tx0 = Math.max(0, Math.floor(x0 * n));
    var tx1 = Math.min(n - 1, Math.floor(x1 * n));
    var ty0 = Math.max(0, Math.floor(y0 * n));
    var ty1 = Math.min(n - 1, Math.floor(y1 * n));

    var tiles = [];
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) tiles.push({ z: zoom, x: tx, y: ty });
    }

    var midLat = bbox.centre ? bbox.centre.lat : worldYToLat((y0 + y1) / 2);

    return {
      bbox: bbox,
      zoom: zoom,
      width: width,
      height: height,
      world: { x0: x0, y0: y0, x1: x1, y1: y1 },
      scale: scale,
      tiles: tiles,
      tileCount: tiles.length,
      // Terrarium tiles average ~90 KB; good enough for a "roughly this big" hint.
      estimatedBytes: tiles.length * 90 * 1024,
      // Ground resolution across the middle of the box, in metres per sample.
      // Measured at the centre latitude rather than an edge, since Mercator
      // scale varies from top to bottom of a tall box.
      metresPerSample:
        haversine(midLat, bbox.west, midLat, bbox.east) / Math.max(1, width - 1)
    };
  }

  var tileTemplate = TILE_URL;

  function tileUrl(t) {
    return tileTemplate.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
  }

  /**
   * Point the tool at a different terrarium-encoded tile source — a mirror, a
   * local cache, or your own DEM. Pass nothing to restore the default.
   * The template takes {z}/{x}/{y}, and the tiles must be 256x256 terrarium
   * PNGs served with permissive CORS headers.
   */
  function setTileUrl(template) {
    tileTemplate = template || TILE_URL;
    tileCache.clear();
  }

  /* ----------------------------------------------------------------- decode */

  /** RGBA bytes -> Float32Array of metres. Pure, so Node can test it. */
  function decodeTerrarium(rgba, width, height) {
    var out = new Float32Array(width * height);
    for (var i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = rgba[p] * 256 + rgba[p + 1] + rgba[p + 2] / 256 - 32768;
    }
    return out;
  }

  /* -------------------------------------------------------------- resample */

  /**
   * Bilinear sample of the assembled tile set at a world-pixel position.
   * Tiles live in a Map keyed "z/x/y"; edge samples clamp to the tile block.
   */
  function makeSampler(tiles, zoom) {
    var n = Math.pow(2, zoom);

    function pixel(px, py) {
      var tx = Math.floor(px / TILE_SIZE);
      var ty = Math.floor(py / TILE_SIZE);
      tx = Math.max(0, Math.min(n - 1, tx));
      ty = Math.max(0, Math.min(n - 1, ty));

      var tile = tiles.get(zoom + '/' + tx + '/' + ty);
      if (!tile) return 0; // outside the fetched block (only at the seams)

      var ix = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(px) - tx * TILE_SIZE));
      var iy = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(py) - ty * TILE_SIZE));
      return tile[iy * TILE_SIZE + ix];
    }

    return function sample(px, py) {
      var x0 = Math.floor(px - 0.5);
      var y0 = Math.floor(py - 0.5);
      var fx = px - 0.5 - x0;
      var fy = py - 0.5 - y0;

      var v00 = pixel(x0, y0);
      var v10 = pixel(x0 + 1, y0);
      var v01 = pixel(x0, y0 + 1);
      var v11 = pixel(x0 + 1, y0 + 1);

      return (
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy
      );
    };
  }

  /**
   * Build the sample grid from decoded tiles. Sampling is uniform in Mercator
   * space, so the resulting grid — and therefore the SVG — is a plain Web
   * Mercator projection of the box, with the correct aspect ratio.
   */
  function buildGrid(plan, tiles) {
    var W = plan.width;
    var H = plan.height;
    var data = new Float32Array(W * H);
    var sample = makeSampler(tiles, plan.zoom);

    var w = plan.world;
    var min = Infinity;
    var max = -Infinity;

    for (var j = 0; j < H; j++) {
      var wy = w.y0 + ((w.y1 - w.y0) * j) / (H - 1);
      var py = wy * plan.scale;
      for (var i = 0; i < W; i++) {
        var wx = w.x0 + ((w.x1 - w.x0) * i) / (W - 1);
        var v = sample(wx * plan.scale, py);
        data[j * W + i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    return { width: W, height: H, data: data, min: min, max: max };
  }

  /* ------------------------------------------------------------------ fetch */

  function decodeBlobToTile(blob) {
    return createImageBitmap(blob).then(function (bmp) {
      var canvas = global.document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, TILE_SIZE, TILE_SIZE);
      if (bmp.close) bmp.close();
      var img = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      return decodeTerrarium(img.data, TILE_SIZE, TILE_SIZE);
    });
  }

  var tileCache = new Map();

  var RETRIES = 2;
  var RETRY_DELAY_MS = 300;

  /**
   * Fetch and decode one tile.
   *
   * A single map pulls tens of tiles, so a one-in-a-hundred hiccup would sink
   * whole runs if the first failure were fatal. Transient errors get a couple
   * of quick retries; a deliberate cancel is never retried.
   */
  function fetchTile(t, signal, attempt) {
    var key = t.z + '/' + t.x + '/' + t.y;
    if (tileCache.has(key)) return Promise.resolve(tileCache.get(key));

    attempt = attempt || 0;

    return fetch(tileUrl(t), { signal: signal, mode: 'cors' })
      .then(function (res) {
        if (!res.ok) throw new Error('tile ' + key + ' returned HTTP ' + res.status);
        return res.blob();
      })
      .then(decodeBlobToTile)
      .then(function (data) {
        tileCache.set(key, data);
        return data;
      })
      .catch(function (err) {
        if ((err && err.name === 'AbortError') || attempt >= RETRIES) throw err;
        return new Promise(function (resolve) {
          setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1));
        }).then(function () {
          return fetchTile(t, signal, attempt + 1);
        });
      });
  }

  /** Run promise-returning jobs with a fixed concurrency limit. */
  function pool(items, limit, worker) {
    var next = 0;
    var active = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) active.push(run());

    function run() {
      if (next >= items.length) return Promise.resolve();
      var item = items[next++];
      return Promise.resolve(worker(item)).then(run);
    }
    return Promise.all(active);
  }

  /**
   * Fetch every tile the plan needs and return the sampled elevation grid.
   * onProgress(done, total) fires as tiles land.
   */
  function fetchGrid(plan, options) {
    options = options || {};
    var signal = options.signal;
    var onProgress = options.onProgress || function () {};

    if (plan.tileCount > MAX_TILES) {
      return Promise.reject(
        new Error(
          'That area needs ' +
            plan.tileCount +
            ' elevation tiles (limit ' +
            MAX_TILES +
            '). Draw a smaller box or lower the terrain detail.'
        )
      );
    }

    var tiles = new Map();
    var done = 0;
    onProgress(0, plan.tileCount);

    return pool(plan.tiles, 6, function (t) {
      return fetchTile(t, signal).then(function (data) {
        tiles.set(t.z + '/' + t.x + '/' + t.y, data);
        onProgress(++done, plan.tileCount);
      });
    })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new Error(
          'Could not load elevation tiles (' +
            err.message +
            '). Check your network connection. If you opened this file directly ' +
            'and your browser blocked the request, serve the folder instead: ' +
            'python3 -m http.server, then open http://localhost:8000/'
        );
      })
      .then(function () {
        return buildGrid(plan, tiles);
      });
  }

  Topo.elevation = {
    TILE_SIZE: TILE_SIZE,
    MAX_ZOOM: MAX_ZOOM,
    MAX_TILES: MAX_TILES,
    ASPECT: ASPECT,
    MIN_ASPECT: MIN_ASPECT,
    MAX_ASPECT: MAX_ASPECT,
    MIN_WIDTH_M: MIN_WIDTH_M,
    MAX_WIDTH_M: MAX_WIDTH_M,
    ATTRIBUTION: ATTRIBUTION,
    lonToWorldX: lonToWorldX,
    latToWorldY: latToWorldY,
    worldXToLon: worldXToLon,
    worldYToLat: worldYToLat,
    haversine: haversine,
    bboxFromCentre: bboxFromCentre,
    planGrid: planGrid,
    tileUrl: tileUrl,
    setTileUrl: setTileUrl,
    decodeTerrarium: decodeTerrarium,
    buildGrid: buildGrid,
    fetchGrid: fetchGrid,
    clearCache: function () {
      tileCache.clear();
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.elevation;
})(typeof globalThis !== 'undefined' ? globalThis : this);
