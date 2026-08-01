/*
 * water.js — the elevation grid as a water surface, one ripple per contour.
 *
 * The other designs in this tool draw the ground: lines between heights,
 * characters standing for heights, words coloured by height. This one pretends
 * the ground is water, and the trick that makes it work is that a contour line
 * is already a level set — every point on it is at the same height. So a wave
 * written as a function of height alone has its crest exactly along one:
 *
 *     phi = (height - lowest level) / the interval between levels
 *     W   = cos(2 * pi * phi)
 *
 * W peaks wherever phi is a whole number, which is wherever a contour runs, and
 * troughs exactly halfway between neighbouring ones. Shade that and every
 * contour becomes the ridge of a ripple, closing in rings around a summit the
 * way rings close around a stone dropped in a pond. Nothing is displaced and
 * nothing is random: the crests cannot drift off the lines, because both are
 * worked out from the same levels the tracer used.
 *
 * The tempting alternative — and the first version of this file — was to shade
 * the terrain's own slopes and wobble the contour lines separately on top. That
 * gives two unrelated wave effects, a sheen running across the picture that owes
 * nothing to the contours and a line that is a ripple only in the sense that it
 * is bent. Neither makes a contour line into the crest of anything.
 *
 * No DOM references — Node can require() this and check the maths without a
 * canvas. That is also why surface() takes a tint callback rather than reaching
 * for palettes.js: no module under src/ depends on another, and keeping it that
 * way means this one can be exercised with a two-line stub.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  var TWO_PI = Math.PI * 2;

  /*
   * Where the sun is, in the picture's own coordinates (x right, y *down*, z
   * out of the page). Upper left, about 38 degrees above the surface.
   *
   * Upper left is the cartographic convention and it is not decoration: relief
   * lit from below reads as inverted, so a light from the lower right turns
   * every swell into a hollow and the whole picture goes inside out.
   */
  var LIGHT = normalise3(-0.55, -0.60, 0.58);

  /*
   * How tight the glint is. Two squarings short of 64 the sheen spreads over
   * whole hillsides and reads as polished plastic; two beyond it the glints are
   * a sample or two across, and the enlargement from grid resolution to the
   * picture turns them into speckle. At 64 a glint is a handful of samples
   * wide, which is what survives that enlargement as a highlight.
   *
   * Evaluated as six squarings rather than Math.pow — about ten times faster
   * over three quarters of a million samples, and exactly reproducible.
   */
  var SHINE = 64;

  /* How much of the shading is there before the sun reaches it. Below about
   * 0.35 the troughs sink to black on a dark palette and take the colour of the
   * water with them. */
  var AMBIENT = 0.45;

  /*
   * The gradient below which a ripple fades out, as a fraction of the average
   * across the map.
   *
   * Ripples are given the same cross-section wherever they are, which means
   * dividing the slope by its own length — and that is undefined on ground with
   * no slope at all. Flattening the divisor here instead fades the wave away on
   * still water, which is the right answer rather than a dodge: level ground
   * has no contours crossing it, so it should have no crests either.
   */
  var FLAT = 0.1;

  function normalise3(x, y, z) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    return [x / len, y / len, z / len];
  }

  /**
   * The slope of one ripple across itself, at a height phi levels above the
   * lowest contour.
   *
   * The surface is cos(2*pi*phi), so its slope is proportional to sin(2*pi*phi):
   * nothing on the crest, nothing in the trough, steepest on the flanks between.
   * The zero at every whole phi is the whole design — that is the contour line,
   * and it is the top of the wave.
   *
   * `sharp` bends the profile without moving it. Raising the sine's magnitude to
   * a power below one lifts the flanks towards their peak sooner, so the crest
   * narrows to an edge and the trough broadens out — a chop rather than a swell.
   * A power is used rather than any of the obvious reshapings that add terms,
   * because those move the zero, and a crest that has moved is no longer on the
   * line it is supposed to be the ripple of.
   */
  function profile(phi, sharp) {
    var s = Math.sin(TWO_PI * phi);
    var power = 1 - 0.6 * (sharp || 0);
    if (power === 1) return s;
    return s < 0 ? -Math.pow(-s, power) : Math.pow(s, power);
  }

  /**
   * Shade the elevation grid as water rippling one crest per contour.
   *
   * Options are `tint` — a function from height 0..1 to [r, g, b], which is how
   * the palette gets in without this file knowing about palettes — plus `base`
   * and `interval`, the lowest contour level and the spacing between levels,
   * and then `depth`, `sharp`, `wash`, `glint` and `ambient`.
   *
   * base and interval are the tracer's own, handed in rather than worked out
   * again from the grid's range. They agree today, but two files deriving the
   * same levels separately is exactly how the crests and the lines would come
   * quietly apart later.
   *
   * Returns { width, height, data }, the data an RGBA Uint8ClampedArray at the
   * grid's own resolution. Turning that into an ImageData and stretching it over
   * the picture is the caller's business, and belongs there: the array this
   * returns does not know what size the picture is, which is precisely why the
   * preview and the download can share one.
   */
  function surface(grid, options) {
    options = options || {};

    var W = grid.width;
    var H = grid.height;
    var src = grid.data;
    var span = grid.max - grid.min;

    var interval = options.interval;
    var base = options.base === undefined ? grid.min : options.base;
    var depth = options.depth === undefined ? 0.55 : options.depth;
    var sharp = options.sharp === undefined ? 0.45 : options.sharp;
    var wash = options.wash === undefined ? 0.25 : options.wash;
    var glint = options.glint === undefined ? 0.35 : options.glint;
    var ambient = options.ambient === undefined ? AMBIENT : options.ambient;

    /*
     * The colour of the water, worked out 256 times instead of once per sample.
     * A palette's lookup walks a list of stops, and at three quarters of a
     * million samples that walk is most of the pass; the table is 768 bytes and
     * finer than an eight-bit channel can show anyway.
     */
    var tint = options.tint || function () { return [0, 0, 0]; };
    var lut = new Uint8Array(256 * 3);
    var k;
    for (k = 0; k < 256; k++) {
      var colour = tint(k / 255);
      lut[k * 3] = colour[0];
      lut[k * 3 + 1] = colour[1];
      lut[k * 3 + 2] = colour[2];
    }

    // The half-vector for the specular term. The picture has no perspective, so
    // the eye is straight out of the page and this is a constant — Blinn's
    // half-vector rather than a mirrored reflection: cheaper, and it gives a
    // broader highlight, which is what an enlarged raster needs.
    var half = normalise3(LIGHT[0], LIGHT[1], LIGHT[2] + 1);

    // Still water: no levels to ripple between. Shaded flat rather than
    // refused, so a caller that gets here on flat ground draws a plain wash
    // instead of dividing by nothing.
    var ripples = interval > 0;

    // What counts as a slope worth rippling, in contour crossings per map
    // width — the same units the gradient below comes out in.
    var floor = ripples ? FLAT * (span / interval) : 0;

    var out = new Uint8ClampedArray(W * H * 4);

    for (var j = 0; j < H; j++) {
      var up = (j > 0 ? j - 1 : 0) * W;
      var down = (j < H - 1 ? j + 1 : H - 1) * W;
      var row = j * W;

      for (var i = 0; i < W; i++) {
        var left = i > 0 ? i - 1 : 0;
        var right = i < W - 1 ? i + 1 : W - 1;

        var h = src[row + i];
        var t = span > 0 ? (h - grid.min) / span : 0;

        var diff = 1;
        var spec = 0;

        if (ripples) {
          var phi = (h - base) / interval;

          /*
           * How fast the levels go by, measured across the map rather than
           * across the samples.
           *
           * Multiplying by (W - 1) turns a difference between neighbours into a
           * gradient per unit of map, and that is what keeps the Terrain detail
           * dropdown from changing how the water looks: at Low there are 384
           * samples where High has 1024, so the raw difference between
           * neighbours is nearly three times larger. In these units the length
           * below is literally how many contours you cross per map width.
           */
          var gx = (src[row + right] - src[row + left]) * 0.5 * (W - 1) / interval;
          var gy = (src[down + i] - src[up + i]) * 0.5 * (H - 1) / interval;
          var glen = Math.sqrt(gx * gx + gy * gy);
          var divisor = glen > floor ? glen : floor;

          /*
           * The uphill direction, at unit length wherever there is a slope
           * worth speaking of. Unit length is what gives every ripple the same
           * cross-section however tightly the contours are packed — which is
           * what makes them read as ripples on water rather than as a hillshade
           * of the ground, where the steep places are simply darker.
           */
          var dirx = divisor > 0 ? gx / divisor : 0;
          var diry = divisor > 0 ? gy / divisor : 0;

          /*
           * Just uphill of a crest the water is falling away behind you, so the
           * surface there tilts along the direction you are walking — hence the
           * normal leaning the same way as the uphill vector rather than
           * against it. Get this sign wrong and every ripple is a groove.
           */
          var slope = depth * profile(phi, sharp);
          var nx = dirx * slope;
          var ny = diry * slope;
          var nlen = Math.sqrt(nx * nx + ny * ny + 1) || 1;
          nx /= nlen;
          ny /= nlen;
          var nz = 1 / nlen;

          diff = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
          if (diff < 0) diff = 0;

          spec = nx * half[0] + ny * half[1] + nz * half[2];
          if (spec < 0) {
            spec = 0;
          } else {
            spec *= spec; spec *= spec; spec *= spec;   // ^8
            spec *= spec; spec *= spec; spec *= spec;   // ^64
          }
        }

        /*
         * How much the height still shows in the colour.
         *
         * Pulled towards the middle of the ramp rather than used straight. The
         * ripples are the thing to look at, and a full depth ramp puts a large
         * pale area over the summit that competes with them; at wash 0 the
         * water is one colour everywhere and only the light shapes it.
         */
        var tone = 0.5 + wash * (t - 0.5);
        var step = tone < 0 ? 0 : tone > 1 ? 255 : Math.round(tone * 255);

        var lit = ambient + (1 - ambient) * diff;
        var shine = 255 * glint * spec;
        var at = (row + i) * 4;

        out[at] = lut[step * 3] * lit + shine;
        out[at + 1] = lut[step * 3 + 1] * lit + shine;
        out[at + 2] = lut[step * 3 + 2] * lit + shine;
        out[at + 3] = 255;
      }
    }

    return { width: W, height: H, data: out };
  }

  Topo.water = {
    LIGHT: LIGHT,
    SHINE: SHINE,
    AMBIENT: AMBIENT,
    FLAT: FLAT,
    profile: profile,
    surface: surface
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.water;
})(typeof globalThis !== 'undefined' ? globalThis : this);
