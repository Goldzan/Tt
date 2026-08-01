/*
 * tool-palettes.js — the standalone tool's looks.
 *
 * The shop's five palettes are an enum: an order carries the id, the server
 * clamps to it, and the design hash includes it, so adding to src/palettes.js
 * would add things to sell. This file is the other half — presets that exist
 * only here, plus the builder that turns the colour controls into a palette
 * object.
 *
 * Everything below is the same data shape src/palettes.js defines, and is fed
 * to the same inkFor()/widthFor() the print renderer uses. No second colour
 * implementation: those two functions are pure, so any object of this shape
 * works with them.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  /* Presets beyond the shop's own. Ramped ones set indexEvery to 0: a heavier
   * line inside a colour ramp reads as a mistake rather than as emphasis. */
  var EXTRA = [
    {
      id: 'blueprint',
      name: 'Blueprint',
      background: [16, 42, 86],
      ink: [186, 214, 255],
      indexEvery: 5
    },
    {
      id: 'noir',
      name: 'Noir',
      background: [10, 10, 10],
      ink: [242, 242, 242],
      indexEvery: 5
    },
    {
      id: 'forest',
      name: 'Forest',
      background: [239, 242, 232],
      ink: [46, 88, 58],
      indexEvery: 5
    },
    {
      id: 'glacier',
      name: 'Glacier',
      background: [246, 251, 252],
      ramp: [[12, 44, 72], [38, 105, 140], [126, 178, 196], [206, 232, 238]],
      indexEvery: 0
    },
    {
      id: 'copper',
      name: 'Copper',
      background: [28, 22, 20],
      ramp: [[92, 52, 36], [164, 96, 52], [214, 148, 78], [240, 206, 142]],
      indexEvery: 0
    },
    {
      id: 'dusk',
      name: 'Dusk',
      background: [24, 18, 38],
      ramp: [[62, 44, 110], [128, 66, 138], [198, 92, 120], [244, 148, 110]],
      indexEvery: 0
    },
    {
      id: 'ocean',
      name: 'Ocean',
      background: [6, 18, 32],
      /* Deep water up to a lit crest — the water design's own colours, and the
       * one the design adopts when it is picked. Five stops rather than the
       * four the other ramps use because the shaded surface spends most of the
       * picture in the middle of the ramp, and the extra stop is what keeps the
       * teal from flattening into one band across the whole swell. */
      ramp: [[8, 26, 52], [16, 62, 96], [26, 116, 138], [104, 186, 190], [214, 240, 236]],
      indexEvery: 0
    }
  ];

  function all() {
    return Topo.palettes.all.concat(EXTRA);
  }

  function get(id) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0];
  }

  /**
   * A palette built from the custom colour controls.
   *
   * `mode` is 'solid' for one ink or 'ramp' for a low-to-high gradient; the
   * ramp is handed straight to inkFor, which interpolates any number of stops.
   */
  function custom(spec) {
    var palette = {
      id: 'custom',
      name: 'Custom',
      background: spec.background,
      indexEvery: 0
    };
    if (spec.mode === 'ramp' && spec.stops && spec.stops.length > 1) {
      palette.ramp = spec.stops;
    } else {
      palette.ink = spec.ink || [26, 26, 26];
    }
    return palette;
  }

  /**
   * Layer the index-contour controls over whatever palette was picked, so the
   * settings survive changing preset. A copy, never a mutation: the presets are
   * module-level objects and one edit would stick to them for the session.
   */
  function withIndex(palette, index) {
    var out = {};
    Object.keys(palette).forEach(function (key) { out[key] = palette[key]; });

    out.indexEvery = index.every || 0;
    out.indexWidth = index.width || 2;
    if (index.ink) out.indexInk = index.ink;
    else delete out.indexInk;

    return out;
  }

  Topo.toolPalettes = {
    extra: EXTRA,
    all: all,
    get: get,
    custom: custom,
    withIndex: withIndex
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
