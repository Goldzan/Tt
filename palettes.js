/*
 * palettes.js — the looks a customer can pick.
 *
 * Shared by the browser preview and the server-side print renderer, on purpose:
 * if these ever diverged, customers would receive something other than what
 * they approved. One definition, both paths.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  var PALETTES = [
    {
      id: 'ink',
      name: 'Ink',
      background: [250, 249, 245],
      ink: [26, 26, 26],
      // Every fifth line is drawn heavier, the way an index contour is on a
      // real topographic sheet. Purely cosmetic, but it is what makes the
      // artwork read as a map rather than as a pattern.
      indexEvery: 5
    },
    {
      id: 'summit',
      name: 'Summit',
      background: [14, 23, 38],
      ink: [235, 240, 248],
      indexEvery: 5
    },
    {
      id: 'sepia',
      name: 'Sepia',
      background: [244, 236, 220],
      ink: [104, 74, 46],
      indexEvery: 5
    },
    {
      id: 'terracotta',
      name: 'Terracotta',
      background: [252, 246, 240],
      ink: [178, 76, 51],
      indexEvery: 5
    },
    {
      id: 'altitude',
      name: 'Altitude',
      background: [252, 251, 248],
      // Ramps low ground to high, so the shape reads even without shading.
      ramp: [[46, 78, 110], [70, 138, 140], [176, 173, 96], [198, 122, 62], [166, 62, 52]],
      indexEvery: 0
    }
  ];

  var byId = {};
  PALETTES.forEach(function (p) { byId[p.id] = p; });

  function get(id) {
    return byId[id] || PALETTES[0];
  }

  /**
   * Is this level an index contour — one of the heavier lines a topographic
   * sheet draws every fifth level? Asked by both the colour and the width, so
   * the two can never disagree about which lines are the emphasised ones.
   */
  function isIndex(palette, index) {
    return !!palette.indexEvery && index % palette.indexEvery === palette.indexEvery - 1;
  }

  /** Colour for one contour level, as [r, g, b]. */
  function inkFor(palette, index, total) {
    // An index contour may carry its own colour. Nothing in the shop's
    // palettes sets one; the standalone tool offers it, because a heavier line
    // in a second colour is how a real sheet separates the two readings.
    if (palette.indexInk && isIndex(palette, index)) return palette.indexInk;

    if (!palette.ramp) return palette.ink;

    var stops = palette.ramp;
    if (stops.length < 2) return stops[0] || palette.ink || [0, 0, 0];

    var t = total > 1 ? (index / (total - 1)) * (stops.length - 1) : 0;
    var i = Math.min(stops.length - 2, Math.floor(t));
    var f = t - i;
    return [
      Math.round(stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f),
      Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f),
      Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f)
    ];
  }

  /**
   * Stroke width for one level, relative to a 1000-unit-wide design.
   * Callers scale it by their own output width.
   */
  function widthFor(palette, index, base) {
    base = base || 1;
    if (isIndex(palette, index)) return base * (palette.indexWidth || 2);
    return base;
  }

  function css(rgb) {
    return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  }

  /** '#1b1b1b', '#eee' or 'rgb(1,2,3)' to [r, g, b]; anything else, mid grey. */
  function parse(colour) {
    var text = String(colour || '').trim();

    var parts = text.match(/^rgba?\(([^)]+)\)$/i);
    if (parts) {
      var n = parts[1].split(',').map(function (v) { return parseInt(v, 10) || 0; });
      return [n[0] || 0, n[1] || 0, n[2] || 0];
    }

    var digits = text.replace('#', '');
    if (digits.length === 3) {
      digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
    }
    if (!/^[0-9a-f]{6}$/i.test(digits)) return [128, 128, 128];
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16)
    ];
  }

  /** [r, g, b] to '#rrggbb' — what an <input type="color"> wants. */
  function hex(rgb) {
    return '#' + rgb.map(function (v) {
      var clamped = Math.max(0, Math.min(255, Math.round(v)));
      return (clamped < 16 ? '0' : '') + clamped.toString(16);
    }).join('');
  }

  Topo.palettes = {
    all: PALETTES,
    get: get,
    isIndex: isIndex,
    inkFor: inkFor,
    widthFor: widthFor,
    css: css,
    parse: parse,
    hex: hex
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.palettes;
})(typeof globalThis !== 'undefined' ? globalThis : this);
