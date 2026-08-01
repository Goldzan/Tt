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

  /*
   * How sharply the mirror comes on as a facet tilts away from the eye.
   *
   * Water reflects almost nothing when you look straight down into it and
   * everything at a grazing angle, and Schlick's approximation puts that at
   * (1 - cos)^5 over a base of about 2%. Taken literally that is useless here:
   * this is a plan view, so the eye is straight overhead, and the steepest
   * facet a ripple reaches is under thirty degrees — where the real answer is
   * two per cent and a reflection control would do nothing at any setting.
   *
   * What is worth keeping is the *shape* — clear on the flats, rising fast on
   * the flanks — so the exponent is dropped to two and the whole curve is
   * normalised against the steepest facet this surface actually has. A setting
   * of 1 then means "as reflective as this water ever gets" rather than a
   * number of per cent nobody can see. Squared rather than linear because the
   * point is the contrast: the mirror belongs on the flanks and the flats
   * belong clear.
   */
  var FRESNEL_POWER = 2;

  /*
   * How far the bed shifts under the steepest part of a wave, as a fraction of
   * the map's width. About one per cent — enough that the ground visibly slides
   * as it passes under a ripple, not so much that it stops looking like the
   * same ground.
   */
  var REFRACT = 0.012;

  /*
   * How bright the light gathered under a crest gets.
   *
   * A crest is convex, so it works as a lens and focuses what passes through it
   * into a band below. This is that band's brightness at full clarity — an
   * approximation drawn from the wave's own curvature rather than any tracing
   * of light, so it lands under every crest alike however deep the water is
   * there. Worth knowing before anyone tries to extend it into something it is
   * not.
   */
  var CAUSTIC = 0.55;

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
   * `reflect`, `clarity`, `skyZenith` and `skyHorizon` are what make it a
   * liquid rather than a shaded solid: how much of the sky the flanks mirror,
   * how far you see into the flats, and what the sky is made of. All three
   * effects fall away to nothing at zero, so a caller with them switched off
   * gets the plain lit surface and this function still has one path through it.
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
     * There is no `realistic` flag here on purpose. The caller zeroes these two
     * when its checkbox is off, and zero is already "no mirror, no wobble, no
     * gathered light" — so the panel gets an honest switch and this file keeps
     * one way of shading a sample rather than two that have to be kept in step.
     */
    var reflect = options.reflect || 0;
    var clarity = options.clarity || 0;

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

    /*
     * The sky the surface mirrors, from the horizon up to straight overhead.
     * Built the same way and for the same reason as the table above: the loop
     * should never blend two colours when it can read one.
     */
    var zenith = options.skyZenith || [58, 110, 165];
    var horizon = options.skyHorizon || [220, 234, 245];
    var sky = new Uint8Array(256 * 3);
    for (k = 0; k < 256; k++) {
      var lift = k / 255;
      sky[k * 3] = horizon[0] + (zenith[0] - horizon[0]) * lift;
      sky[k * 3 + 1] = horizon[1] + (zenith[1] - horizon[1]) * lift;
      sky[k * 3 + 2] = horizon[2] + (zenith[2] - horizon[2]) * lift;
    }

    /*
     * What the steepest facet on this surface scores, so the reflection can be
     * measured against it. The slope never exceeds `depth` — the profile is
     * bounded by one and the uphill direction by unit length — so this is the
     * most tilted the water ever gets.
     *
     * Zero when the water is flat, which is a real case: depth at 0 leaves
     * every facet level, nothing to reflect off, and a divide by nothing.
     */
    var nzMin = 1 / Math.sqrt(depth * depth + 1);
    var fresRef = Math.pow(1 - nzMin, FRESNEL_POWER);
    var mirror = fresRef > 0 ? reflect / fresRef : 0;

    // How far the bed slides under the water, in whole samples at each edge of
    // the grid. Whole samples rather than a bilinear read between four of them:
    // the step that saves is smaller than the one the enlargement to picture
    // size smooths out anyway.
    var refractX = clarity * REFRACT * (W - 1);
    var refractY = clarity * REFRACT * (H - 1);
    var caustic = CAUSTIC * clarity * depth;

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
        var refl = 0;
        var skyStep = 0;
        var focus = 0;
        var bed = h;

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

          if (mirror > 0) {
            // How much of this facet is mirror rather than window. Level water
            // is all window; the flanks of the ripples are where it turns.
            var tilt = 1 - nz;
            refl = mirror * tilt * tilt;
            if (refl > 1) refl = 1;

            /*
             * Which part of the sky lands in it. Reflecting a straight-down
             * view off this facet gives a ray whose vertical component is
             * 2*nz*nz - 1: pointing straight up on level water, which is the
             * zenith, and out at the horizon on a facet at forty-five degrees.
             * Below that would be looking under the horizon, which water seen
             * from above never does, so it stops there.
             *
             * Only the steepness matters, not which way the facet faces. The
             * part of the picture that has to know its direction is the sun's
             * own reflection, and that is the glint above.
             */
            var rz = 2 * nz * nz - 1;
            skyStep = rz > 0 ? Math.round(rz * 255) : 0;
          }

          if (clarity > 0) {
            /*
             * What is under the water, seen through it. The surface leans, so
             * the ground below appears shifted the way the lean points — which
             * is what makes a bed slide about as a wave passes over it.
             *
             * Clamped at the edges rather than wrapped: a wrap would show the
             * far side of the map through the water along the margins.
             */
            var bx = i - Math.round(nx * refractX);
            var by = j - Math.round(ny * refractY);
            if (bx < 0) bx = 0; else if (bx > W - 1) bx = W - 1;
            if (by < 0) by = 0; else if (by > H - 1) by = H - 1;
            bed = src[by * W + bx];

            /*
             * The light a crest gathers. A crest is convex, so it works as a
             * lens: cos(2*pi*phi) is positive exactly over one, and cubing it
             * keeps what follows a band under the crest instead of a general
             * lightening of everything.
             */
            var lens = Math.cos(TWO_PI * phi);
            if (lens > 0) focus = caustic * lens * lens * lens;
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
        var seen = bed === h ? t : (span > 0 ? (bed - grid.min) / span : 0);
        var tone = 0.5 + wash * (seen - 0.5);
        var step = tone < 0 ? 0 : tone > 1 ? 255 : Math.round(tone * 255);

        /*
         * Through the water, then off it.
         *
         * The ground below is lit and given whatever light the crest above it
         * gathered, then mixed with the sky by how much of this facet is
         * mirror. The sun's glint goes on last and on top of the mix: it is the
         * sun rather than the sky, and it has to survive landing on a flank
         * that is already reflecting.
         */
        var lit = ambient + (1 - ambient) * diff;
        var glow = 255 * focus;
        var shine = 255 * glint * spec;
        var clear = 1 - refl;
        var at = (row + i) * 4;

        out[at] = (lut[step * 3] * lit + glow) * clear + sky[skyStep * 3] * refl + shine;
        out[at + 1] = (lut[step * 3 + 1] * lit + glow) * clear + sky[skyStep * 3 + 1] * refl + shine;
        out[at + 2] = (lut[step * 3 + 2] * lit + glow) * clear + sky[skyStep * 3 + 2] * refl + shine;
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
    FRESNEL_POWER: FRESNEL_POWER,
    REFRACT: REFRACT,
    CAUSTIC: CAUSTIC,
    profile: profile,
    surface: surface
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.water;
})(typeof globalThis !== 'undefined' ? globalThis : this);
