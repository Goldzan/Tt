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

  /*
   * How close two letters may come before they are treated as colliding, as a
   * fraction of their combined size. Contours crowd together on steep ground —
   * closer than the lettering is tall — and words from neighbouring lines then
   * print through each other into something nobody can read. Below this, the
   * later of the two gives way.
   */
  var CLEARANCE = 0.85;

  /*
   * The closest two repeats of a phrase may be set, as a fraction of one
   * letter's advance — about a quarter of an em, a little under a word space.
   * This is what stops the packing above from shouldering one repeat into the
   * back of the last when squeezing an extra one in would nearly fit.
   */
  var MIN_GAP = 0.4;

  /*
   * How many places along its slot a phrase may try before giving up. Six is
   * enough to step past a bend without turning placement into a search: the
   * first try is the evenly spaced one, and most phrases never need a second.
   */
  var SLIDE_TRIES = 6;

  /**
   * A record of where letters have already been set, so the next ones can keep
   * out of the way.
   *
   * A grid of buckets rather than a list: what matters is whether anything is
   * near this point, and bucketing makes that a look at nine small buckets
   * instead of a walk through every letter on the map. The cell wants to be
   * comfortably larger than the biggest letter, so a neighbour can never sit
   * further away than one bucket.
   */
  function occupancy(cell) {
    var buckets = new Map();

    function bucket(x, y) {
      return Math.floor(x / cell) + ',' + Math.floor(y / cell);
    }

    return {
      /** Would any of these letters land on top of one already set? */
      blocked: function (placed, size) {
        for (var i = 0; i < placed.length; i++) {
          var cx = Math.floor(placed[i].x / cell);
          var cy = Math.floor(placed[i].y / cell);

          for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
              var here = buckets.get((cx + dx) + ',' + (cy + dy));
              if (!here) continue;

              for (var k = 0; k < here.length; k += 3) {
                var gap = CLEARANCE * (size + here[k + 2]) / 2;
                var ex = placed[i].x - here[k];
                var ey = placed[i].y - here[k + 1];
                if (ex * ex + ey * ey < gap * gap) return true;
              }
            }
          }
        }

        return false;
      },

      /** Remember these letters, now that they are going on the page. */
      claim: function (placed, size) {
        for (var i = 0; i < placed.length; i++) {
          var key = bucket(placed[i].x, placed[i].y);
          var here = buckets.get(key);
          if (!here) buckets.set(key, (here = []));
          here.push(placed[i].x, placed[i].y, size);
        }
      }
    };
  }

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
   * `measured` is what measurePhrase returned; options:
   * { gap, closed, limit, size, space }. `space` is an occupancy shared across
   * the whole picture — pass the same one to every path and no two words will
   * be set on top of each other.
   */
  function layout(points, cum, measured, options) {
    options = options || {};

    var total = cum[cum.length - 1];
    var advance = measured.advance;
    var glyphs = measured.glyphs;
    var gap = options.gap || 0;
    var space = options.space || null;
    var size = options.size || 0;

    if (!(total > 0) || !(advance > 0) || advance > total) return [];

    /*
     * How many repeats fit, and how far apart to set them.
     *
     * Whatever is left over after the repeats is shared out evenly rather than
     * banked in one place. A ring has a gap after its last repeat as well as
     * between them — it has to meet its own beginning — so its slack goes to
     * those gaps and the lettering wraps with no bald patch at the seam.
     *
     * An open path spreads its repeats from one end to the other, first letter
     * at the start and last letter at the finish. Centring the run instead, as
     * this did at first, banks the whole remainder at the two ends: a path a
     * little under twice the length of its phrase came out with a phrase in the
     * middle and a quarter of the line blank at either side. Only a path with a
     * single repeat has ends to pad, and that one is centred.
     */
    function gapAt(n) {
      if (options.closed) return total / n - advance;
      if (n < 2) return total - advance;
      return (total - advance) / (n - 1) - advance;
    }

    /*
     * Which repeat count to take.
     *
     * Rounding down looks like the safe answer and is the one that leaves the
     * holes: a ring a little under twice its phrase drops to a single repeat
     * and wears the entire remainder as one gap — wider than the phrase itself,
     * and the most conspicuous blank on the map. So both counts either side are
     * costed and the one landing nearest the asked-for gap wins, provided it
     * does not shoulder the words up against each other. The setting stays a
     * target rather than becoming a floor, which is what it reads as.
     */
    var floorGap = MIN_GAP * (advance / glyphs.length);
    if (floorGap > gap) floorGap = gap;

    var ideal = options.closed
      ? total / (advance + gap)
      : 1 + (total - advance) / (advance + gap);

    var lo = Math.max(1, Math.floor(ideal));
    var hi = Math.max(1, Math.ceil(ideal));
    var reps = lo;

    if (hi !== lo && gapAt(hi) >= floorGap &&
        Math.abs(gapAt(hi) - gap) < Math.abs(gapAt(lo) - gap)) {
      reps = hi;
    }

    var step = options.closed ? total / reps
      : (reps > 1 ? (total - advance) / (reps - 1) : 0);
    var start = options.closed || reps > 1 ? 0 : (total - advance) / 2;

    // The ceiling is checked a whole repeat at a time: a budget that ran out
    // mid-word would put exactly the half-written litter on the page that the
    // fit test above exists to prevent.
    var limit = options.limit === undefined ? Infinity : options.limit;
    var tracking = measured.tracking || 0;
    var out = [];

    for (var r = 0; r < reps; r++) {
      if (out.length + glyphs.length > limit) break;

      /*
       * Try the phrase where the rhythm wants it, and if it will not go there,
       * walk it along the line looking for somewhere it will.
       *
       * What stops a phrase is nearly always one hairpin under one end of it,
       * and the straight either side would have taken it happily. Abandoning
       * the repeat instead — which is what this did at first — costs a whole
       * phrase-length of blank at every bend on the map, and those blanks were
       * the most visible thing about it. Sliding is bounded by the next
       * repeat's place, and offset zero is tried first, so a line with nothing
       * in its way still comes out evenly spaced.
       */
      var run = null;

      for (var t = 0; t < SLIDE_TRIES; t++) {
        // A lone repeat on an open path has no next repeat to slide towards, so
        // it stays where it was centred rather than being tried six times over.
        if (t > 0 && step <= 0) break;

        var from = start + r * step + (step * t) / SLIDE_TRIES;
        if (from + advance > total) break;
        var to = from + advance;

        // Where each letter's midpoint falls along the path. Midpoints, because
        // a letter on a curve should be centred on it rather than hung off its
        // own left edge.
        var centres = [];
        var at = from;
        for (var g = 0; g < glyphs.length; g++) {
          centres.push(at + glyphs[g].width / 2);
          at += glyphs[g].width + tracking;
        }

        // Set it forwards; if most of it would read right to left, set it the
        // other way instead. The second pass is only paid for when it is needed.
        var candidate = runAlong(points, cum, glyphs, centres, false, from + to);
        if (candidate.upright * 2 < centres.length) {
          candidate = runAlong(points, cum, glyphs, centres, true, from + to);
        }

        // Not if it stands the phrase on its head, and not on top of lettering
        // already there — tested before any of this run is claimed, or its own
        // letters would block each other.
        if (candidate.lean > MAX_LEAN) continue;
        if (space && space.blocked(candidate.placed, size)) continue;

        run = candidate;
        break;
      }

      if (!run) continue;
      if (space) space.claim(run.placed, size);

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
    CLEARANCE: CLEARANCE,
    font: font,
    occupancy: occupancy,
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
