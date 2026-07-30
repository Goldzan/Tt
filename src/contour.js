/*
 * contour.js — marching squares over an elevation grid.
 *
 * Two things here are worth knowing about:
 *
 * 1. Segments are *directed* (high ground always on the left of travel), so
 *    stitching is a plain "this edge leads to that edge" walk rather than a
 *    nearest-point search. Rings come out consistently wound, which matters if
 *    you fill them or send them to a cutter.
 *
 * 2. Crossings are keyed by grid *edge index*, not by rounded coordinates. Two
 *    neighbouring cells that cross the same edge produce the exact same key, so
 *    paths join exactly — no epsilon fudging, no hairline gaps.
 *
 * No DOM references, so Node can require() this for the unit tests.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  /* ----------------------------------------------------------------- levels */

  /**
   * N evenly spaced levels strictly between min and max.
   *
   * Using interval = range / (n + 1) keeps every level in the open interval, so
   * no contour degenerates onto the single highest or lowest sample.
   */
  function computeLevels(min, max, n) {
    if (!(max > min) || n < 1) return [];
    var interval = (max - min) / (n + 1);
    var levels = [];
    for (var i = 1; i <= n; i++) levels.push(min + interval * i);
    return levels;
  }

  /* --------------------------------------------------------- marching squares */

  /*
   * Corners of cell (i, j), and the four edges between them:
   *
   *      TL --T-- TR         index = 8*TL + 4*TR + 2*BR + 1*BL
   *       |        |         (bit set when that corner is >= level)
   *       L        R
   *       |        |
   *      BL --B-- BR
   *
   * Ties are resolved by the >= comparison being applied uniformly, which is
   * what keeps a crossing edge from ever having two equal endpoints — so the
   * interpolation below can never divide by zero.
   */
  var T = 0, R = 1, B = 2, L = 3;

  // Directed segment table, high ground on the left. Complementary cases are
  // exact reversals of each other (1<->14, 2<->13, 3<->12, 4<->11, 6<->9, 7<->8).
  var CASES = [
    [],                 // 0  nothing inside
    [[B, L]],           // 1  BL
    [[R, B]],           // 2  BR
    [[R, L]],           // 3  BR BL
    [[T, R]],           // 4  TR
    null,               // 5  TR BL — saddle
    [[T, B]],           // 6  TR BR
    [[T, L]],           // 7  all but TL
    [[L, T]],           // 8  TL
    [[B, T]],           // 9  TL BL
    null,               // 10 TL BR — saddle
    [[R, T]],           // 11 all but TR
    [[L, R]],           // 12 TL TR
    [[B, R]],           // 13 all but BR
    [[L, B]],           // 14 all but BL
    []                  // 15 everything inside
  ];

  /**
   * Where the level crosses one edge of a cell, by linear interpolation.
   * A crossing edge always has one corner below and one at-or-above the level,
   * so the denominators here are never zero.
   */
  function crossing(which, i, j, a, b, c, e, level, sx, sy, ox, oy) {
    var t;
    switch (which) {
      case T: t = (level - a) / (b - a); return [ox + (i + t) * sx, oy + j * sy];
      case R: t = (level - b) / (c - b); return [ox + (i + 1) * sx, oy + (j + t) * sy];
      case B: t = (level - e) / (c - e); return [ox + (i + t) * sx, oy + (j + 1) * sy];
      default: t = (level - a) / (e - a); return [ox + i * sx, oy + (j + t) * sy];
    }
  }

  /**
   * Trace one iso-level. Returns polylines in grid coordinates
   * (x in 0..width-1, y in 0..height-1), scaled by sx/sy and shifted by ox/oy
   * if given — the shift is how the map gets placed inside a larger frame that
   * also carries type.
   */
  function marchingSquares(grid, level, sx, sy, ox, oy) {
    var W = grid.width;
    var H = grid.height;
    var d = grid.data;

    sx = sx === undefined ? 1 : sx;
    sy = sy === undefined ? 1 : sy;
    ox = ox === undefined ? 0 : ox;
    oy = oy === undefined ? 0 : oy;

    var HC = (W - 1) * H; // horizontal edges come first in the id space

    var points = new Map(); // edge id -> [x, y]
    var next = new Map();   // edge id -> edge id (directed successor)
    var hasPrev = new Set();

    function hid(i, j) { return j * (W - 1) + i; }
    function vid(i, j) { return HC + j * W + i; }

    for (var j = 0; j < H - 1; j++) {
      for (var i = 0; i < W - 1; i++) {
        var a = d[j * W + i];             // TL
        var b = d[j * W + i + 1];         // TR
        var c = d[(j + 1) * W + i + 1];   // BR
        var e = d[(j + 1) * W + i];       // BL

        var idx =
          (a >= level ? 8 : 0) |
          (b >= level ? 4 : 0) |
          (c >= level ? 2 : 0) |
          (e >= level ? 1 : 0);

        if (idx === 0 || idx === 15) continue;

        var segs = CASES[idx];
        if (segs === null) {
          // Saddle: the cell centre decides whether the high ground joins
          // through the middle or the two corners stay separate.
          var centreHigh = (a + b + c + e) / 4 >= level;
          if (idx === 5) {
            segs = centreHigh ? [[T, L], [B, R]] : [[B, L], [T, R]];
          } else {
            segs = centreHigh ? [[R, T], [L, B]] : [[L, T], [R, B]];
          }
        }

        // Edge ids for this cell, in T, R, B, L order to match the table.
        var ids = [hid(i, j), vid(i + 1, j), hid(i, j + 1), vid(i, j)];

        for (var s = 0; s < segs.length; s++) {
          var from = ids[segs[s][0]];
          var to = ids[segs[s][1]];

          if (!points.has(from)) {
            points.set(from, crossing(segs[s][0], i, j, a, b, c, e, level, sx, sy, ox, oy));
          }
          if (!points.has(to)) {
            points.set(to, crossing(segs[s][1], i, j, a, b, c, e, level, sx, sy, ox, oy));
          }

          next.set(from, to);
          hasPrev.add(to);
        }
      }
    }

    /* ------------------------------------------------------------- stitching */

    var paths = [];
    var visited = new Set();

    // Open paths first: they start on an edge nothing leads into, which only
    // happens where the contour runs off the edge of the grid.
    next.forEach(function (_to, from) {
      if (hasPrev.has(from)) return;
      paths.push(walk(from, false));
    });

    // Whatever is left is a closed ring.
    next.forEach(function (_to, from) {
      if (visited.has(from)) return;
      paths.push(walk(from, true));
    });

    function walk(start, closed) {
      var pts = [];

      // Where a contour passes exactly through a grid node, the crossings on
      // the two edges meeting there land on the same coordinate. Collapsing
      // those keeps zero-length segments out of the output.
      function push(x, y) {
        var n = pts.length;
        if (n && pts[n - 2] === x && pts[n - 1] === y) return;
        pts.push(x, y);
      }

      var cur = start;
      while (cur !== undefined && !visited.has(cur)) {
        visited.add(cur);
        var p = points.get(cur);
        push(p[0], p[1]);
        cur = next.get(cur);
      }

      // Closed rings repeat their first point, so the geometry is explicitly
      // closed for resampling; the SVG writer drops it again in favour of Z.
      if (closed) {
        var head = points.get(start);
        push(head[0], head[1]);
      }

      return { points: pts, closed: !!closed };
    }

    return paths.filter(function (p) {
      return p.points.length >= 4;
    });
  }

  /* ---------------------------------------------------------------- speckle */

  /**
   * The larger side of a path's bounding box.
   *
   * The measure behind dropping tiny loops. Bounding box rather than enclosed
   * area because area falls away as the square of the size, so a threshold in
   * area is hard to reason about — and because a long thin ring is a ridge
   * worth keeping even though it encloses almost nothing.
   */
  function extent(pts) {
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    for (var i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }

    return Math.max(maxX - minX, maxY - minY);
  }

  /* -------------------------------------------------------------- resampling */

  function dist(x0, y0, x1, y1) {
    var dx = x1 - x0;
    var dy = y1 - y0;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Place points at a uniform spacing along a polyline.
   *
   * This is the "frequency of data points" control: spacing is in output (SVG)
   * units, so it means the same thing regardless of how dense the terrain grid
   * underneath happens to be. Endpoints are always kept, and any vertex whose
   * turn exceeds cornerAngle survives untouched — otherwise summits and sharp
   * ridge noses would get rounded off at coarse spacings.
   */
  function resample(pts, spacing, cornerAngle) {
    var n = pts.length / 2;
    if (!(spacing > 0) || n < 3) return pts.slice();

    var cosLimit = Math.cos(((cornerAngle === undefined ? 60 : cornerAngle) * Math.PI) / 180);

    // Flag the corners worth protecting.
    var keep = new Uint8Array(n);
    for (var k = 1; k < n - 1; k++) {
      var ax = pts[2 * k] - pts[2 * k - 2];
      var ay = pts[2 * k + 1] - pts[2 * k - 1];
      var bx = pts[2 * k + 2] - pts[2 * k];
      var by = pts[2 * k + 3] - pts[2 * k + 1];
      var la = Math.sqrt(ax * ax + ay * ay);
      var lb = Math.sqrt(bx * bx + by * by);
      if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < cosLimit) keep[k] = 1;
    }

    var out = [pts[0], pts[1]];
    var carried = 0; // distance walked since the last emitted point

    for (var i = 0; i < n - 1; i++) {
      var x0 = pts[2 * i], y0 = pts[2 * i + 1];
      var x1 = pts[2 * i + 2], y1 = pts[2 * i + 3];
      var segLen = dist(x0, y0, x1, y1);
      if (segLen === 0) continue;

      var pos = spacing - carried; // distance into this segment of the next point
      while (pos <= segLen + 1e-9) {
        var t = pos / segLen;
        out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        pos += spacing;
      }
      carried = segLen - (pos - spacing);

      // A protected corner is emitted verbatim and restarts the spacing clock.
      if (i + 1 < n - 1 && keep[i + 1]) {
        out.push(x1, y1);
        carried = 0;
      }
    }

    // Always finish exactly on the original endpoint, so rings still close.
    var lx = pts[2 * n - 2], ly = pts[2 * n - 1];
    if (dist(out[out.length - 2], out[out.length - 1], lx, ly) > 1e-9) out.push(lx, ly);

    return out;
  }

  /* ---------------------------------------------------------------- generate */

  function yieldToUI() {
    return new Promise(function (r) {
      setTimeout(r, 0);
    });
  }

  /**
   * Full pipeline: levels -> traced paths -> resampled paths.
   *
   * Runs one level per tick so the progress bar animates and the page stays
   * responsive. (A worker would be tidier, but workers are blocked when the
   * page is opened straight off the filesystem, and double-clicking
   * index.html has to keep working.)
   */
  function generate(grid, options, onProgress) {
    options = options || {};
    var levelCount = options.levelCount || 10;
    var spacing = options.spacing || 0;
    var cornerAngle = options.cornerAngle;
    var sx = options.scaleX === undefined ? 1 : options.scaleX;
    var sy = options.scaleY === undefined ? 1 : options.scaleY;
    var ox = options.offsetX === undefined ? 0 : options.offsetX;
    var oy = options.offsetY === undefined ? 0 : options.offsetY;
    onProgress = onProgress || function () {};

    /*
     * Drop closed rings narrower than this. Given as a fraction of the map's
     * own width rather than in output units, which is what makes it safe: the
     * same design is traced at 900 px for the preview and at 4500 for the
     * print, and a threshold in units would quietly drop different loops in
     * each. A fraction cannot — sx * (width - 1) is the traced map's width in
     * whatever units the caller is working in.
     *
     * Only closed rings: an open path runs off the edge of the grid, so a short
     * one is the corner of a real contour rather than a speck.
     */
    var minLoop = (options.minLoop || 0) * Math.abs(sx) * (grid.width - 1);

    var levels = computeLevels(grid.min, grid.max, levelCount);
    var layers = [];
    var vertexCount = 0;
    var pathCount = 0;

    var signal = options.signal;

    var i = 0;
    function step() {
      if (signal && signal.aborted) {
        var abort = new Error('Aborted');
        abort.name = 'AbortError';
        return Promise.reject(abort);
      }
      if (i >= levels.length) {
        return Promise.resolve({
          levels: levels,
          layers: layers,
          interval: levels.length > 1 ? levels[1] - levels[0] : 0,
          min: grid.min,
          max: grid.max,
          pathCount: pathCount,
          vertexCount: vertexCount
        });
      }

      var level = levels[i];
      var paths = marchingSquares(grid, level, sx, sy, ox, oy).filter(function (p) {
        // Before resampling: a speck is a speck at any vertex spacing, and
        // this way it never costs the work of being smoothed first.
        return !(minLoop > 0 && p.closed && extent(p.points) < minLoop);
      }).map(function (p) {
        var pts = spacing > 0 ? resample(p.points, spacing, cornerAngle) : p.points;
        vertexCount += pts.length / 2;
        pathCount++;
        return { points: pts, closed: p.closed };
      });

      layers.push({ elevation: level, index: i, paths: paths });
      onProgress(++i, levels.length);
      return yieldToUI().then(step);
    }

    return step();
  }

  Topo.contour = {
    computeLevels: computeLevels,
    marchingSquares: marchingSquares,
    resample: resample,
    extent: extent,
    generate: generate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.contour;
})(typeof globalThis !== 'undefined' ? globalThis : this);
