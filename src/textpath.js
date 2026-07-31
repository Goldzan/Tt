/*
 * textpath.js — setting words along a contour.
 *
 * The contours arrive from contour.js as flat [x0,y0,x1,y1,…] polylines. This
 * turns one of those into a list of placed glyphs — a character, a point and an
 * angle — which is all a canvas needs to draw a line that is made of letters
 * rather than stroked.
 *
 * Three things here are what separate this from "rotate each letter a bit":
 *
 * 1. Glyphs are positioned by their own midpoint along the arc, not by their
 *    left edge, so a letter sitting on a curve is centred on it and the run
 *    keeps its rhythm through a bend.
 *
 * 2. A phrase that would not fit is not drawn at all. Marching squares throws
 *    off plenty of short fragments, and half a word on each of them reads as
 *    litter; a blank there reads as a gap in the line.
 *
 * 3. Runs that would come out upside down are flipped whole. contour.js emits
 *    rings wound consistently (high ground on the left), so on one side of
 *    every ring the direction of travel points back across the page — letters
 *    laid on it naively would be mirrored. Flipping a whole phrase rather than
 *    individual letters is what keeps the word readable.
 *
 * No DOM references: measurement comes in as a function, so Node can require()
 * this and check the geometry without a canvas.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  /*
   * The lettering is set in Source Code Pro, vendored as a woff2 and inlined
   * into the built file so it travels with it. A monospace face is not an
   * accident: even advances mean a phrase bends around a curve without the
   * spacing appearing to breathe, and the fallbacks are monospace too so a
   * browser that never loaded the font degrades in kind rather than in kerning.
   */
  var FONT = '"Source Code Pro", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  var TAU = Math.PI * 2;

  /** The CSS font shorthand for a size in output units and a wght axis value. */
  function font(size, weight) {
    return (weight || 400) + ' ' + size + 'px ' + FONT;
  }

  /* ------------------------------------------------------------------ words */

  /**
   * The words control, parsed: one phrase per line, blanks dropped.
   *
   * Blank lines are dropped rather than kept as empty contours because they are
   * what a person leaves behind while editing the box, and a phrase list that
   * silently shifts every level along as you type would be maddening.
   */
  function phrases(text) {
    return String(text === undefined || text === null ? '' : text)
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  /**
   * Fill in the placeholders a phrase may carry.
   *
   * {elevation} is the contour's own height, which is the thing a printed sheet
   * writes along its lines; it is what makes the feature a map rather than a
   * pattern. Unknown tokens are left standing so a typo shows itself.
   */
  function resolve(phrase, context) {
    context = context || {};
    var metres = context.elevation;

    return String(phrase).replace(/\{(place|elevation|feet|index)\}/g, function (whole, name) {
      if (name === 'place') return context.place === undefined ? whole : String(context.place);
      if (name === 'index') return context.index === undefined ? whole : String(context.index + 1);
      if (metres === undefined || !isFinite(metres)) return whole;
      if (name === 'elevation') return String(Math.round(metres));
      return String(Math.round(metres * 3.28084));
    });
  }

  /** The phrase for one contour level: the list, cycled. */
  function phraseFor(list, index) {
    if (!list.length) return '';
    return list[((index % list.length) + list.length) % list.length];
  }

  /* ------------------------------------------------------------- measurement */

  /**
   * Wrap a measuring function in a per-character cache.
   *
   * measureText is the expensive part of laying out tens of thousands of
   * glyphs, and it is asked the same few dozen questions over and over: the
   * character set of a picture is tiny even when its letter count is not.
   */
  function widths(measure) {
    var cache = new Map();

    return function (ch) {
      var hit = cache.get(ch);
      if (hit === undefined) {
        hit = measure(ch);
        cache.set(ch, hit);
      }
      return hit;
    };
  }

  /**
   * A phrase as glyphs with their advances, and the total that run occupies.
   *
   * Tracking is counted between letters only, not after the last one, so the
   * advance is the ink's true length and gaps between repeats mean what they
   * say.
   */
  function measurePhrase(text, width, tracking) {
    var chars = Array.from(String(text));
    var glyphs = [];
    var advance = 0;

    for (var i = 0; i < chars.length; i++) {
      var w = width(chars[i]);
      glyphs.push({ char: chars[i], width: w });
      advance += w;
      if (i < chars.length - 1) advance += tracking;
    }

    return { glyphs: glyphs, advance: advance, tracking: tracking };
  }

  /* ------------------------------------------------------------ arc sampling */

  /**
   * Cumulative distance to each vertex of a flat polyline.
   *
   * Built once per path and reused by every glyph on it, which turns placement
   * from a walk per letter into a binary search per letter.
   */
  function cumulative(points) {
    var n = points.length / 2;
    var cum = new Float64Array(n);

    for (var i = 1; i < n; i++) {
      var dx = points[2 * i] - points[2 * i - 2];
      var dy = points[2 * i + 1] - points[2 * i - 1];
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
    }

    return cum;
  }

  /** The vertex at or before distance s. */
  function segmentAt(cum, s) {
    var lo = 0;
    var hi = cum.length - 1;

    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid; else hi = mid - 1;
    }

    return lo;
  }

  /**
   * Point and heading at distance s along the polyline.
   *
   * The heading is the segment's own direction rather than an average of its
   * neighbours: contour.js has already resampled these paths to an even vertex
   * spacing, so segments are short and the per-segment tangent is smooth
   * enough, while an average would round off the corners resample() was careful
   * to keep.
   */
  function sampleAt(points, cum, s) {
    var n = cum.length;
    var last = cum[n - 1];
    var d = s < 0 ? 0 : s > last ? last : s;
    var i = segmentAt(cum, d);
    if (i >= n - 1) i = n - 2;

    var x0 = points[2 * i], y0 = points[2 * i + 1];
    var x1 = points[2 * i + 2], y1 = points[2 * i + 3];
    var len = cum[i + 1] - cum[i];
    var t = len > 0 ? (d - cum[i]) / len : 0;

    return {
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
      angle: Math.atan2(y1 - y0, x1 - x0)
    };
  }

  /* ----------------------------------------------------------------- layout */

  /*
   * How far past upright a letter may lean before the phrase is abandoned.
   *
   * A run is flipped as a whole, so a letter leans by its own heading, not by
   * the run's: on a path that turns under the phrase, the letters at the ends
   * lean furthest. Sideways is fine and is what following a curve means; past
   * this it is on its head, and no orientation of the run fixes it, because the
   * letters at the other end would go over instead. A phrase wrapped that
   * tightly is left off, the same answer this file already gives to a path too
   * short to hold one.
   */
  var MAX_LEAN = (125 * Math.PI) / 180;

  /**
   * Set one run of the phrase, one way round or the other, and report on it.
   *
   * Every letter is sampled where it will actually be drawn rather than at some
   * even spacing along the run — a contour can kink between two evenly spaced
   * samples, and the letter that lands in the kink is exactly the one worth
   * catching. So `lean` here is the worst letter, not an estimate of it.
   *
   * Flipping mirrors each midpoint about the run's own span: the phrase is set
   * the other way along the same piece of path. The characters stay in their
   * original order — the mirror already reverses them on the page.
   */
  function runAlong(points, cum, glyphs, centres, flip, span) {
    var placed = [];
    var upright = 0;
    var lean = 0;

    for (var i = 0; i < centres.length; i++) {
      var here = sampleAt(points, cum, flip ? span - centres[i] : centres[i]);
      var angle = flip ? here.angle + Math.PI : here.angle;
      var off = Math.abs(normalise(angle));

      if (off <= Math.PI / 2) upright++;
      if (off > lean) lean = off;

      placed.push({ char: glyphs[i].char, x: here.x, y: here.y, angle: angle });
    }

    return { placed: placed, upright: upright, lean: lean };
  }

  /**
   * Place one phrase repeatedly along a path.
   *
   * Returns [] when the path cannot hold the phrase once — see the note at the
   * top of the file about fragments.
   *
   * `measured` is what measurePhrase returned; options: { gap, closed, limit }.
   */
  function layout(points, cum, measured, options) {
    options = options || {};

    var total = cum[cum.length - 1];
    var advance = measured.advance;
    var glyphs = measured.glyphs;
    var gap = options.gap || 0;

    if (!(total > 0) || !(advance > 0) || advance > total) return [];

    /*
     * How many repeats fit, and how far apart to set them.
     *
     * A closed ring is measured with a gap after the last repeat as well as
     * between them — it has to meet its own beginning — and whatever slack is
     * left over is shared out among those gaps rather than dumped at the seam.
     * That is what makes a ring read as continuous lettering instead of a
     * sentence with a hole in it. An open path has no seam, so its slack goes
     * to the two ends and centres the run.
     */
    var reps;
    var step;
    var start;

    if (options.closed) {
      reps = Math.max(1, Math.floor(total / (advance + gap)));
      step = total / reps;
      start = 0;
    } else {
      reps = Math.max(1, Math.floor((total + gap) / (advance + gap)));
      step = advance + gap;
      start = (total - (reps * advance + (reps - 1) * gap)) / 2;
    }

    // The ceiling is checked a whole repeat at a time: a budget that ran out
    // mid-word would put exactly the half-written litter on the page that the
    // fit test above exists to prevent.
    var limit = options.limit === undefined ? Infinity : options.limit;
    var tracking = measured.tracking || 0;
    var out = [];

    for (var r = 0; r < reps; r++) {
      if (out.length + glyphs.length > limit) break;

      var from = start + r * step;
      var to = from + advance;

      // Where each letter's midpoint falls along the path. Midpoints, because a
      // letter on a curve should be centred on it rather than hung off its own
      // left edge.
      var centres = [];
      var at = from;
      for (var g = 0; g < glyphs.length; g++) {
        centres.push(at + glyphs[g].width / 2);
        at += glyphs[g].width + tracking;
      }

      // Set it forwards; if most of it would read right to left, set it the
      // other way instead. The second pass is only paid for when it is needed.
      var run = runAlong(points, cum, glyphs, centres, false, from + to);
      if (run.upright * 2 < centres.length) {
        run = runAlong(points, cum, glyphs, centres, true, from + to);
      }

      // Neither way round could keep the phrase off its head: leave it out.
      if (run.lean > MAX_LEAN) continue;

      for (var p = 0; p < run.placed.length; p++) out.push(run.placed[p]);
    }

    return out;
  }

  /** An angle folded into (-π, π]; the check a test wants for "not upside down". */
  function normalise(angle) {
    var a = angle % TAU;
    if (a > Math.PI) a -= TAU;
    if (a <= -Math.PI) a += TAU;
    return a;
  }

  Topo.textpath = {
    FONT: FONT,
    MAX_LEAN: MAX_LEAN,
    font: font,
    phrases: phrases,
    resolve: resolve,
    phraseFor: phraseFor,
    widths: widths,
    measurePhrase: measurePhrase,
    cumulative: cumulative,
    sampleAt: sampleAt,
    layout: layout,
    normalise: normalise
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.textpath;
})(typeof globalThis !== 'undefined' ? globalThis : this);
