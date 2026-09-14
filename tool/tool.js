/*
 * tool.js — the standalone map maker.
 *
 * Everything happens in this page: terrain tiles come straight from AWS, the
 * contours are traced here, the picture is painted into a canvas here, and the
 * PNG is encoded by the browser. There is no server behind it, which is why the
 * whole thing can be one file on a disk.
 *
 * The work is cached in three stages, because they cost wildly different
 * amounts. Moving the pin refetches tiles (network). Changing the number of
 * lines retraces (a second of CPU). Changing a colour repaints (a frame). A
 * colour must never cost a download, so each stage is keyed and only the ones
 * downstream of what actually changed are rerun.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var Topo = global.Topo;

  var elevation = Topo.elevation;
  var search = Topo.search;
  var palettes = Topo.palettes;
  var presets = Topo.toolPalettes;
  var render = Topo.toolRender;
  var textpath = Topo.textpath;
  var ascii = Topo.ascii;

  var SLIDER_MAX = 1000;

  // Terrain samples across the picture. More than the data holds is refused by
  // planGrid anyway, so these are ceilings rather than promises.
  var DETAIL = { low: 384, medium: 640, high: 1024 };

  /* A canvas has limits browsers do not agree on and do not announce: past
   * them, allocation fails or toBlob quietly returns null. Refusing early, with
   * a reason, beats a blank download. */
  var MAX_SIDE = 10000;
  var MAX_PIXELS = 40e6;

  var MIN_SIDE = 200;

  /* The printable area on each side of the shirt, as fractions of the photo:
   * the most a print may cover, and the edges no drag or slider can push it
   * past. Measured off the photos. The two are the same size; the back's sits
   * higher because its collar does. */
  var PRINT_AREA = {
    front: { left: 0.340, top: 0.2955, right: 0.660, bottom: 0.643 },
    back: { left: 0.340, top: 0.25, right: 0.660, bottom: 0.60 }
  };

  /* Where the print starts on each side, inside that area. size is how much
   * of it the print fills (1 is as large as the picture's shape allows there);
   * across and down are where it sits in the room left over (0 against the
   * left or top edge, 1 against the right or bottom). Full size, centred, at
   * the top. */
  var PLACEMENT_DEFAULTS = {
    front: { size: 1, across: 0.5, down: 0 },
    back: { size: 1, across: 0.5, down: 0 }
  };

  var MIN_PRINT_SIZE = 0.1;

  var state = {
    /* Which picture this is. 'contours' draws lines between heights; 'ascii'
     * draws the heights themselves as characters; 'words' fills the frame with
     * words and lets their colour carry the height; 'water' reads the ground as
     * a lit water surface and pushes every contour into a ripple across it. All
     * four share the elevation grid, the colours, the picture size and the
     * download — only what is made of the ground differs. */
    design: 'contours',

    lat: 46.8523,
    lng: -121.7603,
    place: 'Mount Rainier',

    widthM: 12000,
    levels: 20,
    detail: 'medium',
    tidy: true,

    imageW: 1600,
    imageH: 1200,
    margin: 0,

    preset: 'ink',
    custom: false,
    mode: 'solid',
    ink: '#1a1a1a',
    stops: ['#2e4e6e', '#b24c33'],
    background: '#faf9f5',
    transparent: true,

    weight: 2,
    indexEvery: 5,
    indexWidth: 2,
    indexTint: false,
    indexInk: '#b24c33',

    /* A line round the map area. The width is in the same canonical units as
     * the line weights; no ink means the colour of the outermost contour line,
     * followed through every change of palette until a colour is picked. */
    borderOn: true,
    borderWidth: 4,
    borderInk: null,

    /* Lettering. The words are one phrase per line, cycled up the levels, and
     * the default uses the placeholders so a fresh map says something true
     * about itself before anyone has typed anything. Sizes are in the same
     * canonical 1000-wide units as the line weights. */
    textOn: false,
    textWords: '{place}\n{elevation} m',
    textCaps: true,
    textSize: 7,
    textWeight: 500,
    textTracking: 0.06,
    textGap: 1.5,
    textKeepLines: false,

    /* The ASCII design. Columns is the only resolution that matters — the rows
     * follow from it so the ground keeps its shape — and the ramp's own length
     * is how many steps of height it stands for. */
    asciiCols: 110,
    asciiRamp: Topo.ascii.RAMP,
    asciiInvert: false,
    asciiWeight: 500,

    /* The word block. Same grid as the ASCII design, but the words are the
     * same everywhere and the colour is the only thing carrying the ground. */
    wordCols: 90,
    wordList: Topo.ascii.WORDS,
    wordSeparator: Topo.ascii.SEPARATOR,
    wordCaps: true,
    wordWeight: 500,

    /* The water design. Note what is *not* a setting here: how many ripples
     * there are. A ripple is a contour — the surface is a wave in height whose
     * crests fall on the levels — so the count is the level count, and it lives
     * in the Terrain panel with every other design's reading of the ground. */
    waterDepth: 0.55,
    waterSharp: 0.45,
    waterWash: 0.25,
    waterGlint: 0.35,
    waterLines: true,
    waterWeight: 0.9,

    /* What makes it a liquid rather than a lit solid: the flanks of the ripples
     * mirror the sky while the flats between them are seen into, the ground
     * below slides about as a wave passes over it, and each crest gathers a
     * band of light beneath itself. The sky has to be given, because a picture
     * of water from directly above has no horizon in it to take one from. */
    waterRealistic: true,
    waterReflect: 0.45,
    waterClarity: 0.5,
    waterSkyTop: '#3a6ea5',
    waterSkyLow: '#dceaf5',

    /* The T-shirt preview. 'flat' is the picture as it downloads; 'front' and
     * 'back' put it on the shirt photos. Each side keeps its own placement, so
     * a small print on the chest and a big one on the back can both stand. A
     * placement is relative to that side's print area, so no setting can put
     * the print outside it, whatever shape the picture is. */
    view: 'flat',
    placement: mergePlacement(PLACEMENT_DEFAULTS),
    // Which photo the print goes on; one of SHIRT_COLOURS. Shared by both
    // sides, the way a real shirt is.
    shirtColour: 'white',

    scale: 1,
    filename: ''
  };

  /* Stage caches. The keys say what each stage depends on; anything not in a
   * key cannot invalidate it. */
  var cache = { terrainKey: '', grid: null, traceKey: '', result: null, geometry: null };

  var picker = null;
  var terrainAbort = null;
  var traceAbort = null;
  var runToken = null;
  var debounce = null;
  var searchAbort = null;
  var mockupBusy = false;

  function $(id) { return doc.getElementById(id); }

  // To the metre, which the slider never needs — its widths are whole hundreds
  // of metres at least — but a typed 12.25 km is not 12.3 km.
  function fmtDistance(m) {
    return m >= 1000 ? +(m / 1000).toFixed(3) + ' km' : Math.round(m) + ' m';
  }

  /*
   * A readout to `places` decimals — or to as many as three when a typed value
   * has them, so that 1.25 typed in reads back as 1.25 rather than as a 1.3
   * that is not what is being drawn.
   */
  function fixed(value, places) {
    var typed = +value.toFixed(3);
    return typed === +value.toFixed(places) ? value.toFixed(places) : String(typed);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /* ------------------------------------------------------------ derivations */

  function detailSamples() {
    return DETAIL[state.detail] || DETAIL.medium;
  }

  /** The map rectangle inside the picture, and the shape the ground must be. */
  function area() {
    return render.frame(state.imageW, state.imageH, state.margin);
  }

  function bbox() {
    return elevation.bboxFromCentre(
      { lat: state.lat, lng: state.lng },
      state.widthM,
      area().aspect
    );
  }

  /**
   * The lettering the controls currently describe.
   *
   * One helper for both the preview and the download, because the two must
   * describe the same picture — a difference here would only ever be found
   * after the PNG had been saved.
   */
  function textOptions() {
    return {
      on: state.textOn,
      phrases: textpath.phrases(state.textWords),
      place: state.place,
      caps: state.textCaps,
      size: state.textSize,
      weight: state.textWeight,
      tracking: state.textTracking,
      gap: state.textGap,
      keepLines: state.textKeepLines
    };
  }

  /**
   * Wait for the lettering face before drawing with it.
   *
   * An @font-face nothing in the page renders is never fetched, and a canvas
   * asked to use one it has not got does not wait — it draws in a fallback with
   * different widths, so the layout would be measured against one face and set
   * in another. Resolved once and remembered; a browser without the API, or one
   * that fails to load it, falls through to the monospace stack and still draws.
   */
  var fontReady = null;
  var fontLoaded = false;

  function ensureFont() {
    if (fontReady) return fontReady;

    var fonts = doc.fonts;
    var loading = fonts && fonts.load
      ? fonts.load('16px "Source Code Pro"').catch(function () { return null; })
      : Promise.resolve(null);

    // The flag, not the promise, is what paint() tests: a resolved promise
    // chained to another paint would paint forever.
    fontReady = loading.then(function (result) {
      fontLoaded = true;
      return result;
    });

    return fontReady;
  }

  function isContours() { return state.design === 'contours'; }
  function isAscii() { return state.design === 'ascii'; }
  function isWords() { return state.design === 'words'; }
  function isWater() { return state.design === 'water'; }

  /**
   * Is this a grid of characters?
   *
   * Most of the branching in this file wants this question rather than which
   * design exactly: both grids are made straight from the elevation, need no
   * trace, need the lettering face, and count what they drew the same way.
   */
  function usesCells() { return isAscii() || isWords(); }

  /**
   * Does this design need the contours traced?
   *
   * Several places below used to ask this by asking isContours(), which was the
   * same question only while contours were the only design made of lines. The
   * water design is the second — its ripples are the traced contours, displaced
   * — so the question gets its own name rather than a longer disjunction
   * repeated at each site.
   */
  function needsTrace() { return isContours() || isWater(); }

  /** Is the stage showing the picture on a shirt rather than flat? */
  function isShirt() { return state.view === 'front' || state.view === 'back'; }

  /**
   * A placement for both sides, each number taken from `over` where it gives
   * one and from `base` otherwise.
   *
   * Always a fresh copy, so the defaults are never the object being dragged
   * about, and a script can nudge one number on one side without restating
   * the rest.
   */
  function mergePlacement(base, over) {
    var out = {};
    ['front', 'back'].forEach(function (side) {
      var given = (over && over[side]) || {};
      out[side] = {};
      ['size', 'across', 'down'].forEach(function (key) {
        var value = given[key];
        out[side][key] = typeof value === 'number' && isFinite(value)
          ? clamp(value, key === 'size' ? MIN_PRINT_SIZE : 0, 1)
          : base[side][key];
      });
    });
    return out;
  }

  /**
   * Where the print sits on a shirt photo W × H pixels in size, and how much
   * room it has left to move inside the print area.
   *
   * Full size is the largest print of the picture's shape the area holds;
   * size scales that down, and across and down share out whatever room is
   * left over. So the print is inside the area by construction, for every
   * placement and every picture shape, rather than clamped back into it
   * afterwards. One helper for the preview, the drag and the mockup download,
   * so the saved file puts the print exactly where it was dragged to.
   */
  function printRect(side, width, height) {
    var area = PRINT_AREA[side];
    var place = state.placement[side];
    var aspect = state.imageW / state.imageH;
    var areaW = (area.right - area.left) * width;
    var areaH = (area.bottom - area.top) * height;
    var w = Math.min(areaW, areaH * aspect) * place.size;
    var h = w / aspect;
    var roomX = areaW - w;
    var roomY = areaH - h;
    return {
      x: area.left * width + roomX * place.across,
      y: area.top * height + roomY * place.down,
      w: w,
      h: h,
      roomX: roomX,
      roomY: roomY
    };
  }

  /** The ASCII design's settings, for the preview and the download alike. */
  function asciiOptions() {
    return {
      cols: state.asciiCols,
      ramp: state.asciiRamp,
      invert: state.asciiInvert,
      weight: state.asciiWeight,
      margin: state.margin,
      transparent: state.transparent
    };
  }

  /** The word block's settings — one helper, so preview and PNG agree. */
  function wordOptions() {
    return {
      cols: state.wordCols,
      // {place} resolved here so a list can name the mountain it is drawing.
      words: ascii.words(state.wordList).map(function (word) {
        return textpath.resolve(word, { place: state.place });
      }).join('\n'),
      separator: state.wordSeparator,
      caps: state.wordCaps,
      weight: state.wordWeight,
      margin: state.margin,
      transparent: state.transparent
    };
  }

  /** The water design's settings — one helper, so preview and PNG agree. */
  function waterOptions() {
    return {
      depth: state.waterDepth,
      sharp: state.waterSharp,
      wash: state.waterWash,
      glint: state.waterGlint,
      lines: state.waterLines,
      weight: state.waterWeight,
      /* Zeroed rather than passed with a flag beside them. No mirror and no
       * clarity is already the plain lit surface, so the renderer keeps one way
       * of shading a sample and the checkbox is still an honest switch. */
      reflect: state.waterRealistic ? state.waterReflect : 0,
      clarity: state.waterRealistic ? state.waterClarity : 0,
      skyZenith: palettes.parse(state.waterSkyTop),
      skyHorizon: palettes.parse(state.waterSkyLow),
      margin: state.margin,
      transparent: state.transparent,
      // What the terrain currently is, so the renderer can keep the shaded
      // surface between repaints. It is passed rather than worked out there
      // because this file already knows it, and fingerprinting the grid itself
      // would cost more than the shading the memo is meant to save.
      key: cache.terrainKey
    };
  }

  /** The palette the controls currently describe. */
  function palette() {
    var base = state.custom
      ? presets.custom({
        mode: state.mode,
        ink: palettes.parse(state.ink),
        stops: state.stops.map(palettes.parse),
        background: palettes.parse(state.background)
      })
      : presets.get(state.preset);

    var out = presets.withIndex(base, indexSettings());
    // The background picker always wins, and picking a preset moves it to that
    // preset's own colour — so what the swatch shows is what gets drawn.
    out.background = palettes.parse(state.background);
    return out;
  }

  /**
   * Take on a preset's own colours and line rhythm.
   *
   * A preset is a whole look, not just a set of inks: the ramped ones set
   * indexEvery to 0 because a heavier line inside a colour ramp reads as a
   * mistake. Adopting those settings into the controls rather than silently
   * overriding them keeps the panel honest — everything drawn is something
   * visible on screen, and still editable afterwards.
   */
  function adoptPreset(id) {
    var preset = presets.get(id);
    state.preset = preset.id;
    state.custom = false;
    state.background = palettes.hex(preset.background);
    state.indexEvery = preset.indexEvery || 0;

    $('bg').value = state.background;
    $('index-every').value = state.indexEvery;
    $('index-every-val').textContent = state.indexEvery ? 'every ' + state.indexEvery : 'off';
    $('custom-panel').hidden = true;
    $('custom-toggle').setAttribute('aria-pressed', 'false');
    renderPalettes();
  }

  function indexSettings() {
    return {
      /* Index contours are a contour idea: every nth line drawn heavier. The
       * ASCII design asks the palette for a colour per ramp step, and an index
       * rule applied to those steps would tint every nth one — banding across
       * the map that nothing on screen would explain. So it is off there. */
      every: isContours() ? state.indexEvery : 0,
      width: state.indexWidth,
      ink: state.indexTint ? palettes.parse(state.indexInk) : null
    };
  }

  function exportSize() {
    return {
      width: Math.round(state.imageW * state.scale),
      height: Math.round(state.imageH * state.scale)
    };
  }

  /** Why a requested picture cannot be made, or null if it can. */
  function sizeProblem(width, height) {
    if (width > MAX_SIDE || height > MAX_SIDE) {
      return 'Each side has to stay under ' + MAX_SIDE + ' px.';
    }
    if (width * height > MAX_PIXELS) {
      return 'That is ' + (width * height / 1e6).toFixed(0) +
        ' megapixels; browsers stop encoding PNGs somewhere below ' +
        (MAX_PIXELS / 1e6) + '. Lower the resolution.';
    }
    return null;
  }

  function slug(text) {
    return String(text || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'map';
  }

  function defaultFilename() {
    var size = exportSize();
    return slug(state.place) + '-' + size.width + 'x' + size.height + '.png';
  }

  /* ------------------------------------------------------------------ status */

  function status(message, busy) {
    $('status').textContent = message || '';
    $('stage').classList.toggle('busy', !!busy);
  }

  function progress(fraction) {
    $('progress').style.width = Math.round(clamp(fraction, 0, 1) * 100) + '%';
    $('progress').hidden = fraction === null;
  }

  function stats() {
    if (!cache.grid || (needsTrace() && !cache.result)) {
      $('stats').textContent = '';
      return;
    }
    var plan = cache.plan;
    var result = cache.result;
    var shape = cache.geometry;

    // The ground's range and how finely it was sampled belong to either
    // design; what sits between them is what each one made of it.
    $('stats').textContent = [
      Math.round(cache.grid.min) + '–' + Math.round(cache.grid.max) + ' m',
      usesCells()
        ? (shape && shape.cols ? shape.cols + ' × ' + shape.rows + ' characters' : '')
        : (result.interval
          ? Math.round(result.interval) + ' m between ' + (isWater() ? 'ripples' : 'lines')
          : ''),
      usesCells() ? '' : result.pathCount + ' paths',
      Math.round(plan.metresPerSample) + ' m/sample at zoom ' + plan.zoom
    ].filter(Boolean).join(' · ');
  }

  /* ---------------------------------------------------------------- pipeline */

  /**
   * Bring the picture up to date, doing as little as the change allows.
   *
   * Every run takes a token; a run whose token has been superseded stops
   * without painting, and the fetch and the trace it started are aborted
   * outright so a dragged slider does not leave six of them racing.
   */
  function run() {
    var token = {};
    runToken = token;
    var live = function () { return runToken === token; };

    var terrainKey, plan;
    try {
      var box = bbox();
      plan = elevation.planGrid(box, detailSamples());
      terrainKey = [state.lat, state.lng, state.widthM, box.aspect.toFixed(6),
        detailSamples()].join('|');
    } catch (err) {
      status(err.message, false);
      progress(null);
      return Promise.resolve();
    }

    cache.plan = plan;
    syncMap(false);

    var terrain;
    if (cache.grid && cache.terrainKey === terrainKey) {
      terrain = Promise.resolve(cache.grid);
    } else {
      if (terrainAbort) terrainAbort.abort();
      terrainAbort = new global.AbortController();
      status('Fetching ' + plan.tileCount + ' elevation tile' +
        (plan.tileCount === 1 ? '' : 's') + '…', true);
      progress(0);

      // The fetch owns the first half of the bar when a trace follows it, and
      // the whole of it when nothing does — otherwise the ASCII design's bar
      // would stop at the middle and vanish.
      var share = needsTrace() ? 0.5 : 1;

      terrain = elevation.fetchGrid(plan, {
        signal: terrainAbort.signal,
        onProgress: function (done, total) {
          if (live()) progress(total ? (done / total) * share : 0);
        }
      }).then(function (grid) {
        cache.grid = grid;
        cache.terrainKey = terrainKey;
        cache.traceKey = '';
        return grid;
      });
    }

    return terrain
      .then(function (grid) {
        if (!live()) return null;

        /*
         * The grids of characters are finished at this point: they want the
         * grid and nothing else, and binning it into cells is a paint-stage
         * job. The grid is returned because the next step treats a falsy result
         * as "nothing happened" and would leave the status line mid-sentence.
         *
         * Flat ground stops a design made of lines — there is nothing to draw
         * one between, and no contours means no ripples either — but it is a
         * perfectly good picture in characters, so that refusal belongs below
         * this line rather than above it.
         */
        if (!needsTrace()) return grid;

        if (!(grid.max > grid.min)) {
          throw new Error('That area is flat — every sample reads ' +
            Math.round(grid.min) + ' m, so there are no contours to draw.');
        }

        var traceKey = [terrainKey, state.levels, state.tidy, state.margin,
          state.imageW, state.imageH].join('|');
        if (cache.result && cache.traceKey === traceKey) return cache.result;

        if (traceAbort) traceAbort.abort();
        traceAbort = new global.AbortController();
        status('Tracing ' + state.levels + ' contour levels…', true);

        // Traced in the canonical frame rather than at the canvas's size, so
        // the same geometry serves the preview at any window width.
        var design = designFrame();
        return render.trace(grid, design.area, {
          levels: state.levels,
          spacing: render.PREVIEW_SPACING,
          tidy: state.tidy,
          signal: traceAbort.signal,
          onProgress: function (done, total) {
            if (live()) progress(0.5 + (total ? (done / total) * 0.5 : 0));
          }
        }).then(function (result) {
          cache.result = result;
          cache.traceKey = traceKey;
          return result;
        });
      })
      .then(function (result) {
        if (!live() || !result) return;
        paint();
        stats();
        status(describe(), false);
        if (usesCells()) syncCellNotes();
        progress(null);
      })
      .catch(function (err) {
        if (!live() || (err && err.name === 'AbortError')) return;
        status(err.message, false);
        progress(null);
      });
  }

  /** The canonical 1000-wide frame the preview geometry is traced into. */
  function designFrame() {
    var width = render.DESIGN_WIDTH;
    var height = Math.round(width * (state.imageH / state.imageW));
    return { width: width, height: height, area: render.frame(width, height, state.margin) };
  }

  function describe() {
    var size = exportSize();
    var made = isAscii() ? state.asciiCols + ' characters across'
      : isWords() ? state.wordCols + ' characters across'
        : isWater() ? state.levels + ' ripples'
          : state.levels + ' lines';
    var line = state.place + ' · ' + fmtDistance(state.widthM) + ' across · ' +
      made + ' · ' + size.width + ' × ' + size.height + ' px';

    // The one thing about the lettering worth interrupting with: a size small
    // enough to run past the glyph ceiling leaves part of the map unlettered,
    // and nothing else on screen would explain why.
    if (cache.geometry && cache.geometry.clipped) {
      line += ' · lettering stopped at ' + cache.geometry.glyphs +
        ' letters — try a larger letter size or fewer lines';
    }

    return line;
  }

  /* ---------------------------------------------------------------- painting */

  /**
   * The whole picture at a given size, whichever design is on.
   *
   * One place decides this, and both the preview and the download come through
   * it — a difference between the two would only ever show up in a saved PNG.
   * `traced` is the contour geometry the download re-traced at its own size;
   * the preview passes nothing and the cached trace is used.
   */
  function specFor(width, height, traced) {
    return render.withBorder(designSpecFor(width, height, traced), borderOptions());
  }

  /** The border the controls describe — one helper, so preview and PNG agree. */
  function borderOptions() {
    return {
      on: state.borderOn,
      width: state.borderWidth,
      // Null follows the outermost contour line, whatever colour that is now.
      ink: state.borderInk ? palettes.parse(state.borderInk) : null,
      margin: state.margin
    };
  }

  /** The design's own picture, before any border goes round it. */
  function designSpecFor(width, height, traced) {
    if (isAscii()) {
      return render.asciiGeometry(cache.grid, palette(), width, height, asciiOptions());
    }
    if (isWords()) {
      return render.wordsGeometry(cache.grid, palette(), width, height, wordOptions());
    }
    // The only design that wants both: the ripples are made from the trace, and
    // the water they sit on is made from the elevation directly.
    if (isWater()) {
      return render.waterGeometry(traced || cache.result, cache.grid, palette(),
        width, height, waterOptions());
    }
    return render.geometry(traced || cache.result, palette(), width, height, {
      weight: state.weight,
      transparent: state.transparent,
      text: textOptions()
    });
  }

  /**
   * Repaint from cached geometry. This is the cheap path: colours, thickness
   * and index settings all end here without touching the network or the tracer.
   */
  function paint() {
    // The designs need different things to exist: a grid of characters needs
    // only the ground, lines need the trace made from it, and the water design
    // is the one that needs both — a shaded surface off the elevation with the
    // traced contours rippling over it.
    if (!cache.grid) return;
    if (needsTrace() && !cache.result) return;

    var design = designFrame();
    var spec = specFor(design.width, design.height);
    cache.geometry = spec;
    syncBorderInk(spec);

    var canvas = $('view');
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    // A canvas nobody has laid out yet measures zero; 900 is the width the
    // stage settles at, and it beats quietly allocating the picture's full
    // pixel size on screen.
    var cssWidth = canvas.clientWidth || 900;
    canvas.style.height = Math.round(cssWidth / (state.imageW / state.imageH)) + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(canvas.width * (state.imageH / state.imageW));

    // The checkerboard behind a transparent picture belongs to the page, not to
    // the artwork, so it is CSS on the canvas rather than pixels in it.
    canvas.classList.toggle('alpha', state.transparent);

    render.draw(canvas, spec);

    // Drawn once in whatever face was to hand, then again properly. Only ever
    // one repeat: fontLoaded is set before this can run a second time. A grid
    // of characters needs this as much as the lettering does — more, even,
    // since its column positions come from the face's advance, and a fallback
    // with a different one would misalign every column in the picture.
    //
    // Asked as "which designs set type" rather than as "which design is this
    // not": the water design draws no letters at all, and the question the
    // other way round would send it off to wait for a face it never uses and
    // then repaint the whole picture for nothing.
    var setsType = !!spec.text || spec.kind === 'ascii' || spec.kind === 'words';
    if (setsType && !fontLoaded) ensureFont().then(paint);

    // Every repaint of the picture is a repaint of the shirt it is printed on.
    paintMockup();
  }

  /**
   * The border's colour picker, while the border follows the contours.
   *
   * What it follows is only known once a spec has been made — another palette
   * or another design changes the outermost line's colour — so the picker is
   * brought up to date after each one. A picked colour is left alone.
   */
  function syncBorderInk(spec) {
    var following = !state.borderInk;
    if (following && spec.border) $('border-ink').value = palettes.hex(spec.border.colour);
    $('border-match').disabled = following;
    $('border-note').textContent = following
      ? 'Following the colour of the outermost contour line.'
      : 'Your own colour. Match the contours to follow them again.';
  }

  /* ----------------------------------------------------------------- mockup */

  var PRINT_FIELDS = { 'print-size': 'size', 'print-across': 'across', 'print-down': 'down' };

  function pct(fraction) {
    return +(fraction * 100).toFixed(1) + '%';
  }

  /**
   * The shirt photo, and the print multiplied into it.
   *
   * Multiplied rather than laid over, the way ink takes on cloth: the folds and
   * shadows of the fabric darken the print, and a white background vanishes
   * into the white shirt instead of sitting on it like a sticker — which is
   * also why a transparent one needs nothing special. One function for the
   * preview and the mockup download, so the two cannot disagree.
   */
  function compose(ctx, photo, print, rect, width, height) {
    ctx.drawImage(photo, 0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(print, rect.x, rect.y, rect.w, rect.h);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* The shirt colours there are photos of, with the names the panel shows. The
   * photos are the <img> tags on the stage, one per side and colour, so a new
   * colour is two photos, a tag for each, a line here and a swatch. */
  var SHIRT_COLOURS = { white: 'White', blue: 'Blue', green: 'Green', pink: 'Pink' };

  /** The chosen shirt colour, or white if it is not one there are photos of. */
  function currentShirtColour() {
    return SHIRT_COLOURS[state.shirtColour] ? state.shirtColour : 'white';
  }

  /** The <img> for a side in the chosen colour. */
  function shirtImage(side) {
    return $('shirt-' + side + '-' + currentShirtColour());
  }

  /** The photo for a side, or null while it is still being decoded. */
  function shirtPhoto(side) {
    var photo = shirtImage(side);
    return photo && photo.complete && photo.naturalWidth ? photo : null;
  }

  /**
   * Put the picture on the shirt, straight from the preview canvas.
   *
   * No second render: #view already holds the picture at more pixels than a
   * print a third of the stage wide can show, so this is one drawImage — cheap
   * enough to run for every step of a drag.
   */
  function paintMockup() {
    if (!isShirt()) return;

    // The sliders too, because what they can do depends on the picture's
    // shape, and a new shape arrives here as a repaint.
    syncPlacement();

    var photo = shirtPhoto(state.view);
    if (!photo) {
      // An inlined image still decodes in its own time; draw once it has.
      shirtImage(state.view).addEventListener('load', paintMockup, { once: true });
      return;
    }

    var canvas = $('mockup');
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var aspect = photo.naturalWidth / photo.naturalHeight;
    var cssWidth = canvas.clientWidth || 900;
    canvas.style.height = Math.round(cssWidth / aspect) + 'px';
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(canvas.width / aspect);

    var ctx = canvas.getContext('2d');
    var rect = printRect(state.view, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    compose(ctx, photo, $('view'), rect, canvas.width, canvas.height);

    // While the print is being dragged, the area it is held inside, so the
    // place where it stops moving is not a mystery. The preview's alone: the
    // download is the shirt as it would be printed, with no guides on it. Mid
    // grey, because it has to show on the dark shirts as well as the light.
    if (canvas.classList.contains('dragging')) {
      var area = PRINT_AREA[state.view];
      ctx.save();
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineWidth = dpr;
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
      ctx.strokeRect(area.left * canvas.width, area.top * canvas.height,
        (area.right - area.left) * canvas.width, (area.bottom - area.top) * canvas.height);
      ctx.restore();
    }
  }

  /**
   * Show the stage and the panel for whichever view is on.
   *
   * The visibility is settled here, before anything paints, because paint()
   * measures #view to size it — and a canvas measured while hidden is sized
   * by a guess.
   */
  function syncMockup() {
    var shirt = isShirt();

    Array.prototype.forEach.call(doc.getElementsByName('view'), function (radio) {
      radio.checked = radio.value === state.view;
    });

    $('view').hidden = shirt;
    $('mockup').hidden = !shirt;
    $('shirt-hint').hidden = shirt;
    $('shirt-rows').hidden = !shirt;
    $('shirt-side').textContent = shirt ? '— ' + state.view : '';

    Array.prototype.forEach.call(doc.getElementsByName('shirt-colour'), function (radio) {
      radio.checked = radio.value === currentShirtColour();
    });
    $('shirt-colour-val').textContent = SHIRT_COLOURS[currentShirtColour()];

    $('download-mockup').textContent = shirt
      ? 'Download ' + state.view + ' mockup'
      : 'Download mockup';
    $('download-mockup').disabled = !shirt || mockupBusy;

    syncPlacement();
  }

  /** The placement sliders, for the side on the stage. */
  function syncPlacement() {
    if (!isShirt()) return;
    var place = state.placement[state.view];
    Object.keys(PRINT_FIELDS).forEach(function (id) {
      var value = place[PRINT_FIELDS[id]];
      $(id).value = value * 100;
      $(id + '-val').textContent = pct(value);
    });

    // A print that already spans the area one way has no room to move that
    // way, and a slider that did nothing would only look broken.
    var photo = shirtPhoto(state.view);
    var rect = printRect(state.view, photo ? photo.naturalWidth : 1000,
      photo ? photo.naturalHeight : 1000);
    $('print-across').disabled = rect.roomX < 0.5;
    $('print-down').disabled = rect.roomY < 0.5;
    // Nor should the number beside it offer to be typed into.
    ['print-across', 'print-down'].forEach(function (id) {
      $(id + '-val').setAttribute('aria-disabled', String($(id).disabled));
    });

    $('print-reset').textContent = 'Reset the ' + state.view;
  }

  /* ----------------------------------------------------------------- export */

  /**
   * Render the picture at its full pixel size and download it.
   *
   * The contours are traced again at that size rather than the preview's
   * geometry being scaled up: vertex spacing is in output units, so an
   * enlargement would show every facet the preview was allowed to have. The
   * elevation grid is reused, so this costs CPU and no network.
   */
  function download() {
    if (!cache.grid) {
      status('Nothing to download yet — pick a place first.', false);
      return Promise.resolve(null);
    }

    var size = exportSize();
    var problem = sizeProblem(size.width, size.height);
    if (problem) {
      status(problem, false);
      return Promise.resolve(null);
    }

    status('Rendering ' + size.width + ' × ' + size.height + '…', true);
    progress(0);
    $('download').disabled = true;

    return renderPicture(size.width, size.height, function (done, total) {
      progress(total ? done / total : 0);
    })
      .then(function (canvas) {
        var name = $('filename').value.trim() || defaultFilename();
        if (!/\.png$/i.test(name)) name += '.png';
        return render.toPng(canvas, name);
      })
      .then(function (blob) {
        status('Saved ' + size.width + ' × ' + size.height + ' PNG (' +
          (blob.size / 1048576).toFixed(1) + ' MB).', false);
        progress(null);
        $('download').disabled = false;
        return blob;
      })
      .catch(function (err) {
        status(err.message, false);
        progress(null);
        $('download').disabled = false;
        throw err;
      });
  }

  /**
   * The picture drawn at an exact pixel size, on a canvas of its own.
   *
   * Both downloads come through here: the PNG at the size asked for, and the
   * print at the size it covers on the shirt.
   *
   * Designs made of lines are traced again at the output size; characters are
   * not.
   *
   * The re-trace exists because vertex spacing is in output units, so an
   * enlarged preview would show its facets. A character grid has no such
   * problem: the columns are the same columns, only bigger, because the cell
   * width and the size that fills it both come from the output frame. So a
   * grid of characters downloads as the preview enlarged, exactly, for no
   * CPU at all.
   *
   * Asked as needsTrace() rather than as the absence of cells, so that a
   * fifth design cannot land in the gap between the two questions.
   */
  function renderPicture(width, height, onProgress) {
    var made = !needsTrace()
      ? Promise.resolve(null)
      : render.trace(cache.grid, render.frame(width, height, state.margin), {
        levels: state.levels,
        spacing: render.EXPORT_SPACING,
        tidy: state.tidy,
        onProgress: onProgress
      });

    return made
      .then(function (result) {
        // The face has to be in hand before the offscreen canvas letters with
        // it; nothing on the page has necessarily rendered it yet.
        return ensureFont().then(function () { return result; });
      })
      .then(function (result) {
        var canvas = render.offscreen(width, height);
        render.draw(canvas, specFor(width, height, result));
        return canvas;
      });
  }

  function mockupFilename(side, colour) {
    var typed = $('filename').value.trim().replace(/\.png$/i, '');
    return (typed || slug(state.place)) + '-' + side + '-' + colour + '-mockup.png';
  }

  /**
   * Save the shirt on the stage with the print on it.
   *
   * At the photo's own size, since that is all the detail the shirt has. The
   * print is rendered afresh at the size it covers there rather than taken
   * from the preview, so its lines are as clean as the plain download's — and
   * weighted as the preview showed them, because line weights follow the
   * picture's width.
   */
  function downloadMockup() {
    if (!isShirt()) {
      status('Choose T-shirt front or back above the picture first.', false);
      return Promise.resolve(null);
    }
    if (!cache.grid) {
      status('Nothing to put on the shirt yet — pick a place first.', false);
      return Promise.resolve(null);
    }

    var side = state.view;
    var colour = currentShirtColour();
    var photo = shirtPhoto(side);
    if (!photo) {
      status('The shirt photo is still loading — try again in a moment.', false);
      return Promise.resolve(null);
    }

    var width = photo.naturalWidth;
    var height = photo.naturalHeight;
    // Taken now, so dragging the print while this renders cannot tear the
    // saved file between two placements.
    var rect = printRect(side, width, height);

    status('Rendering the ' + side + ' mockup…', true);
    progress(0);
    mockupBusy = true;
    syncMockup();

    function done() {
      progress(null);
      mockupBusy = false;
      syncMockup();
    }

    return renderPicture(Math.max(1, Math.round(rect.w)), Math.max(1, Math.round(rect.h)),
      function (step, total) { progress(total ? step / total : 0); })
      .then(function (print) {
        var canvas = render.offscreen(width, height);
        compose(canvas.getContext('2d'), photo, print, rect, width, height);
        return render.toPng(canvas, mockupFilename(side, colour));
      })
      .then(function (blob) {
        status('Saved the ' + side + ' mockup, ' + width + ' × ' + height + ' PNG (' +
          (blob.size / 1048576).toFixed(1) + ' MB).', false);
        done();
        return blob;
      })
      .catch(function (err) {
        status(err.message, false);
        done();
        throw err;
      });
  }

  /* -------------------------------------------------------------------- map */

  function syncMap(fit) {
    if (!picker) return;
    var box;
    try {
      box = bbox();
    } catch (err) {
      return;
    }
    picker.setCentre(state.lat, state.lng);
    picker.setBox(box);
    if (fit) picker.fitBox(box);
  }

  function setCentre(lat, lng, fit) {
    state.lat = lat;
    state.lng = lng;
    $('lat').value = lat.toFixed(5);
    $('lng').value = lng.toFixed(5);
    syncMap(fit);
    schedule();
  }

  /* ----------------------------------------------------------------- search */

  function runSearch() {
    var text = $('q').value.trim();
    if (!text) return;

    if (searchAbort) searchAbort.abort();
    searchAbort = new global.AbortController();

    $('search-hint').textContent = 'Searching…';
    search.query(text, { signal: searchAbort.signal })
      .then(function (results) {
        if (!results.length) {
          $('search-hint').textContent = 'Nothing found. Try a nearby town, or type coordinates.';
          $('results').hidden = true;
          return;
        }
        $('search-hint').textContent = 'Pick one, or drag the pin.';
        showResults(results);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        $('search-hint').textContent = err.message;
      });
  }

  function showResults(results) {
    var box = $('results');
    box.textContent = '';
    results.forEach(function (result) {
      var button = doc.createElement('button');
      button.type = 'button';
      var name = doc.createElement('span');
      name.className = 'r-name';
      name.textContent = result.name;
      var meta = doc.createElement('span');
      meta.className = 'r-meta';
      meta.textContent = result.label;
      button.appendChild(name);
      button.appendChild(meta);
      button.addEventListener('click', function () { choose(result); });
      box.appendChild(button);
    });
    box.hidden = false;
  }

  function choose(result) {
    state.place = result.name;
    setWidth(search.widthForResult(result));
    $('filename').placeholder = defaultFilename();
    $('results').hidden = true;
    $('q').value = result.name;
    $('search-hint').textContent = 'Centred on ' + result.name + '.';
    setCentre(result.lat, result.lng, true);
  }

  /* ---------------------------------------------------------------- sliders */

  function sliderToWidth(pos) {
    var ratio = elevation.MAX_WIDTH_M / elevation.MIN_WIDTH_M;
    var metres = elevation.MIN_WIDTH_M * Math.pow(ratio, pos / SLIDER_MAX);
    var step = metres < 10000 ? 100 : metres < 50000 ? 500 : 1000;
    return clamp(Math.round(metres / step) * step, elevation.MIN_WIDTH_M, elevation.MAX_WIDTH_M);
  }

  function widthToSlider(metres) {
    var ratio = elevation.MAX_WIDTH_M / elevation.MIN_WIDTH_M;
    var clamped = clamp(metres, elevation.MIN_WIDTH_M, elevation.MAX_WIDTH_M);
    return Math.round((SLIDER_MAX * Math.log(clamped / elevation.MIN_WIDTH_M)) / Math.log(ratio));
  }

  /**
   * Cover this much ground, from a search result or a typed distance.
   *
   * Not from the slider, which sets the width off its own position: putting
   * the thumb back where the rounded width says would nudge it under the
   * pointer mid-drag. Everything else that sets a width moves the thumb to
   * match, and goes no nearer the slider's notches than the metre.
   */
  function setWidth(metres) {
    state.widthM = clamp(Math.round(metres), elevation.MIN_WIDTH_M, elevation.MAX_WIDTH_M);
    $('width').value = widthToSlider(state.widthM);
    $('width-val').textContent = fmtDistance(state.widthM);
  }

  /* --------------------------------------------------------------- controls */

  /** Rerun the pipeline, debounced, so a dragged slider fires once. */
  function schedule() {
    clearTimeout(debounce);
    debounce = setTimeout(run, 200);
  }

  function repaint() {
    paint();
    // The readout describes what was just drawn, so it is refreshed here as
    // well as after a run: switching design is a repaint, and without this the
    // panel would go on quoting the contour spacing under a block of words.
    stats();
    status(describe(), false);
    // The derived row count is only known once a spec exists, so the note that
    // reports it is refreshed wherever one is made.
    if (usesCells()) syncCellNotes();
  }

  var ASPECTS = [
    { label: '1:1', w: 1600, h: 1600 },
    { label: '4:3', w: 1600, h: 1200 },
    { label: '3:2', w: 1800, h: 1200 },
    { label: '16:9', w: 1920, h: 1080 },
    { label: 'A4 ↑', w: 2480, h: 3508 },
    { label: 'A4 →', w: 3508, h: 2480 },
    { label: 'A3 ↑', w: 3508, h: 4961 },
    { label: 'Phone', w: 1080, h: 1920 },
    { label: 'Desktop', w: 2560, h: 1440 }
  ];

  function renderAspects() {
    var box = $('aspects');
    ASPECTS.forEach(function (spec) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = spec.label;
      button.title = spec.w + ' × ' + spec.h;
      button.addEventListener('click', function () {
        setImageSize(spec.w, spec.h);
      });
      box.appendChild(button);
    });
  }

  function setImageSize(width, height) {
    state.imageW = clamp(Math.round(width), MIN_SIDE, MAX_SIDE);
    state.imageH = clamp(Math.round(height), MIN_SIDE, MAX_SIDE);

    var aspect = state.imageW / state.imageH;
    if (aspect < elevation.MIN_ASPECT || aspect > elevation.MAX_ASPECT) {
      status('That shape is past what the terrain sampler will draw (between ' +
        elevation.MIN_ASPECT + ' and ' + elevation.MAX_ASPECT + ' wide ÷ high).', false);
    }

    $('img-w').value = state.imageW;
    $('img-h').value = state.imageH;
    syncExportNote();
    schedule();
  }

  function syncExportNote() {
    var size = exportSize();
    var problem = sizeProblem(size.width, size.height);
    $('export-size').textContent = size.width + ' × ' + size.height + ' px';
    $('export-note').textContent = problem || '';
    $('filename').placeholder = defaultFilename();
    $('download').disabled = !!problem;
  }

  /* --------------------------------------------------------------- palettes */

  function renderPalettes() {
    var box = $('palettes');
    box.textContent = '';

    presets.all().forEach(function (preset) {
      var button = doc.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (!state.custom && state.preset === preset.id ? ' on' : '');
      button.title = preset.name;
      button.style.background = palettes.css(preset.background);

      for (var i = 0; i < 3; i++) {
        var line = doc.createElement('b');
        line.style.background = palettes.css(palettes.inkFor(preset, i, 3));
        button.appendChild(line);
      }

      button.addEventListener('click', function () {
        adoptPreset(preset.id);
        repaint();
      });

      box.appendChild(button);
    });
  }

  function renderStops() {
    var box = $('stops');
    box.textContent = '';

    state.stops.forEach(function (colour, i) {
      var row = doc.createElement('div');
      row.className = 'stop';

      var input = doc.createElement('input');
      input.type = 'color';
      input.value = colour;
      input.addEventListener('input', function () {
        state.stops[i] = input.value;
        repaint();
      });
      row.appendChild(input);

      var caption = doc.createElement('span');
      caption.textContent = i === 0 ? 'lowest ground'
        : i === state.stops.length - 1 ? 'highest ground' : 'stop ' + (i + 1);
      row.appendChild(caption);

      var remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.disabled = state.stops.length <= 2;
      remove.addEventListener('click', function () {
        state.stops.splice(i, 1);
        renderStops();
        repaint();
      });
      row.appendChild(remove);

      box.appendChild(row);
    });

    $('add-stop').disabled = state.stops.length >= 6;
  }

  function syncColourMode() {
    $('solid-row').hidden = state.mode !== 'solid';
    $('ramp-row').hidden = state.mode !== 'ramp';
  }

  /* ----------------------------------------------------------------- design */

  /**
   * Show the controls this design has, hide the ones it does not.
   *
   * Everything about the ground, the picture and the download is shared; what
   * differs is only what gets made of the ground, so those are the only
   * sections that move. Contour-only controls are hidden rather than disabled
   * because a greyed-out panel of settings that cannot apply is just a longer
   * page to scroll past.
   */
  function syncDesign() {
    // Not named `ascii`: that is the module at the top of this file, and
    // shadowing it here would hide it from everything below.
    var lines = isContours();
    var traced = needsTrace();

    $('ascii-section').hidden = !isAscii();
    $('words-section').hidden = !isWords();
    $('water-section').hidden = !isWater();

    // How many levels to trace, and whether to drop the specks, are questions
    // for any design made of lines. Thickness, index contours and the lettering
    // are contour ideas the water design answers its own way or not at all.
    $('contour-terrain').hidden = !traced;
    $('contour-tidy').hidden = !traced;
    $('contour-colour').hidden = !lines;
    $('text-section').hidden = !lines;

    // The slider is the same slider; what it counts is not, and a panel that
    // said "Contour lines" over a picture of water would be lying about it.
    $('levels-label').textContent = isWater() ? 'Ripples' : 'Contour lines';

    // Why a big download is worth having differs, and the traced answer is not
    // true of characters — nothing is traced again.
    $('download-note').textContent = traced
      ? 'The contours are traced again at the full size, so a 4× file is ' +
        'genuinely sharper rather than an enlargement.'
      : 'The same characters, drawn larger — the grid does not change with the ' +
        'size, so a 4× file is the picture at 4× and not a different one.';

    Array.prototype.forEach.call(doc.getElementsByName('design'), function (radio) {
      radio.checked = radio.value === state.design;
    });

    syncCellNotes();
  }

  /**
   * What the two character panels report back.
   *
   * The ramp's step count and the word count are worth showing because neither
   * is a setting anywhere — each is however much was typed — and the grid size
   * because it is derived, so being told is the only way to know what the
   * picture will be.
   */
  function syncCellNotes() {
    var steps = ascii.ramp(state.asciiRamp).length;
    $('ascii-steps-val').textContent = steps + (steps === 1 ? ' step' : ' steps');

    var count = ascii.words(state.wordList).length;
    $('words-count-val').textContent = count + (count === 1 ? ' word' : ' words');

    var shape = cache.geometry;
    var size = shape && (shape.kind === 'ascii' || shape.kind === 'words')
      ? 'Currently ' + shape.cols + ' × ' + shape.rows + '.'
      : '';
    $('ascii-grid-note').textContent = shape && shape.kind === 'ascii' ? size : '';
    $('words-grid-note').textContent = shape && shape.kind === 'words' ? size : '';
  }

  /* ------------------------------------------------------------------- text */

  /**
   * How many phrases the box holds, and how far up the map they reach.
   *
   * Worth saying because the list cycles: with three phrases and twenty
   * contours nothing is missing, but it is not obvious from the box alone that
   * the fourth line up has gone back to the first phrase.
   */
  function syncWordCount() {
    var count = textpath.phrases(state.textWords).length;
    $('text-count').textContent = count === 0 ? 'none'
      : count === 1 ? '1 phrase, every line'
        : count + ' phrases, cycled';
  }

  /* ------------------------------------------------------------------- wire */

  function wire() {
    $('search-go').addEventListener('click', runSearch);
    $('q').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); runSearch(); }
    });

    ['lat', 'lng'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var lat = parseFloat($('lat').value);
        var lng = parseFloat($('lng').value);
        if (!isFinite(lat) || !isFinite(lng)) return;
        state.place = state.place || 'Map';
        setCentre(lat, lng, true);
      });
    });

    $('basemap').addEventListener('change', function () {
      if (picker) picker.setBasemap($('basemap').value);
    });

    $('width').addEventListener('input', function () {
      state.widthM = sliderToWidth(parseFloat($('width').value));
      $('width-val').textContent = fmtDistance(state.widthM);
      syncMap(false);
      schedule();
    });

    $('levels').addEventListener('input', function () {
      state.levels = parseInt($('levels').value, 10);
      $('levels-val').textContent = state.levels;
      schedule();
    });

    $('detail').addEventListener('change', function () {
      state.detail = $('detail').value;
      schedule();
    });

    $('tidy').addEventListener('change', function () {
      state.tidy = $('tidy').checked;
      schedule();
    });

    $('img-w').addEventListener('change', function () {
      setImageSize(parseInt($('img-w').value, 10) || state.imageW, state.imageH);
    });
    $('img-h').addEventListener('change', function () {
      setImageSize(state.imageW, parseInt($('img-h').value, 10) || state.imageH);
    });
    $('swap').addEventListener('click', function () {
      setImageSize(state.imageH, state.imageW);
    });

    $('margin').addEventListener('input', function () {
      state.margin = parseInt($('margin').value, 10) / 100;
      $('margin-val').textContent = Math.round(state.margin * 100) + '%';
      schedule();
    });

    $('bg').addEventListener('input', function () {
      state.background = $('bg').value;
      repaint();
    });

    $('transparent').addEventListener('change', function () {
      state.transparent = $('transparent').checked;
      $('bg').disabled = state.transparent;
      repaint();
    });

    $('custom-toggle').addEventListener('click', function () {
      state.custom = !state.custom;
      $('custom-toggle').setAttribute('aria-pressed', String(state.custom));
      $('custom-panel').hidden = !state.custom;
      renderPalettes();
      repaint();
    });

    Array.prototype.forEach.call(doc.getElementsByName('mode'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.mode = radio.value;
        syncColourMode();
        repaint();
      });
    });

    $('ink').addEventListener('input', function () {
      state.ink = $('ink').value;
      repaint();
    });

    $('add-stop').addEventListener('click', function () {
      state.stops.push(state.stops[state.stops.length - 1]);
      renderStops();
      repaint();
    });

    $('weight').addEventListener('input', function () {
      state.weight = parseFloat($('weight').value);
      $('weight-val').textContent = fixed(state.weight, 1) + '×';
      repaint();
    });

    $('index-every').addEventListener('input', function () {
      state.indexEvery = parseInt($('index-every').value, 10) || 0;
      $('index-every-val').textContent = state.indexEvery ? 'every ' + state.indexEvery : 'off';
      repaint();
    });

    $('index-width').addEventListener('input', function () {
      state.indexWidth = parseFloat($('index-width').value);
      $('index-width-val').textContent = fixed(state.indexWidth, 1) + '×';
      repaint();
    });

    $('index-tint').addEventListener('change', function () {
      state.indexTint = $('index-tint').checked;
      $('index-ink').disabled = !state.indexTint;
      repaint();
    });

    $('index-ink').addEventListener('input', function () {
      state.indexInk = $('index-ink').value;
      repaint();
    });

    /* --------------------------------------------------------------- design */

    Array.prototype.forEach.call(doc.getElementsByName('design'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.design = radio.value;

        /*
         * Water arrives with its own colours, because on the default cream
         * paper and black ink it would be a pencil drawing of a sea rather than
         * a sea. Adopting the preset rather than quietly overriding the palette
         * is what keeps the panel honest: the swatch that lights up is the one
         * being drawn, the background picker moves to match, and any other
         * palette is still one click away afterwards.
         *
         * After state.design, which adoptPreset reads on its way through
         * renderPalettes and indexSettings, and before anything paints.
         */
        if (isWater()) adoptPreset('ocean');

        syncDesign();
        /*
         * A repaint, not a rerun. Every design is made from the same elevation
         * grid, and it is already in hand — switching is a frame, not a
         * download. The one case that needs more is arriving at a design made
         * of lines with no trace yet, which paint() declines to draw and run()
         * then supplies.
         */
        if (needsTrace() && !cache.result) { schedule(); return; }
        repaint();
      });
    });

    $('ascii-cols').addEventListener('input', function () {
      state.asciiCols = parseInt($('ascii-cols').value, 10);
      $('ascii-cols-val').textContent = state.asciiCols;
      repaint();
    });

    // Typing a ramp changes every character on the map, so it waits for a
    // pause the same way the words box does.
    var rampDebounce = null;
    $('ascii-ramp').addEventListener('input', function () {
      state.asciiRamp = $('ascii-ramp').value;
      syncCellNotes();
      clearTimeout(rampDebounce);
      rampDebounce = setTimeout(repaint, 150);
    });

    $('ascii-invert').addEventListener('change', function () {
      state.asciiInvert = $('ascii-invert').checked;
      repaint();
    });

    $('ascii-weight').addEventListener('input', function () {
      state.asciiWeight = parseInt($('ascii-weight').value, 10);
      $('ascii-weight-val').textContent = state.asciiWeight;
      repaint();
    });

    /* ----------------------------------------------------------- word block */

    $('word-cols').addEventListener('input', function () {
      state.wordCols = parseInt($('word-cols').value, 10);
      $('word-cols-val').textContent = state.wordCols;
      repaint();
    });

    // Rebuilding the block on every keystroke would relay every letter on the
    // map, so the words and the separator both wait for a pause.
    var wordDebounce = null;
    function typedWords() {
      syncCellNotes();
      clearTimeout(wordDebounce);
      wordDebounce = setTimeout(repaint, 150);
    }

    $('word-list').addEventListener('input', function () {
      state.wordList = $('word-list').value;
      typedWords();
    });

    $('word-separator').addEventListener('input', function () {
      state.wordSeparator = $('word-separator').value;
      typedWords();
    });

    $('word-caps').addEventListener('change', function () {
      state.wordCaps = $('word-caps').checked;
      repaint();
    });

    $('word-weight').addEventListener('input', function () {
      state.wordWeight = parseInt($('word-weight').value, 10);
      $('word-weight-val').textContent = state.wordWeight;
      repaint();
    });

    /* ---------------------------------------------------------------- water */

    /* The wave controls rebuild every vertex on the map and the surface ones
     * reshade the whole grid, so they wait for a pause the way the typed boxes
     * do rather than doing that work for each notch of a dragged slider. */
    var waterDebounce = null;
    function waterChanged() {
      clearTimeout(waterDebounce);
      waterDebounce = setTimeout(repaint, 120);
    }

    $('water-depth').addEventListener('input', function () {
      state.waterDepth = parseFloat($('water-depth').value);
      $('water-depth-val').textContent = fixed(state.waterDepth, 2);
      waterChanged();
    });

    $('water-sharp').addEventListener('input', function () {
      state.waterSharp = parseFloat($('water-sharp').value);
      $('water-sharp-val').textContent = fixed(state.waterSharp, 2);
      waterChanged();
    });

    $('water-wash').addEventListener('input', function () {
      state.waterWash = parseFloat($('water-wash').value);
      $('water-wash-val').textContent = fixed(state.waterWash, 2);
      waterChanged();
    });

    $('water-glint').addEventListener('input', function () {
      state.waterGlint = parseFloat($('water-glint').value);
      $('water-glint-val').textContent = fixed(state.waterGlint, 2);
      waterChanged();
    });

    $('water-realistic').addEventListener('change', function () {
      state.waterRealistic = $('water-realistic').checked;
      $('water-real-rows').hidden = !state.waterRealistic;
      waterChanged();
    });

    $('water-reflect').addEventListener('input', function () {
      state.waterReflect = parseFloat($('water-reflect').value);
      $('water-reflect-val').textContent = fixed(state.waterReflect, 2);
      waterChanged();
    });

    $('water-clarity').addEventListener('input', function () {
      state.waterClarity = parseFloat($('water-clarity').value);
      $('water-clarity-val').textContent = fixed(state.waterClarity, 2);
      waterChanged();
    });

    ['water-sky-top', 'water-sky-low'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        if (id === 'water-sky-top') state.waterSkyTop = $(id).value;
        else state.waterSkyLow = $(id).value;
        waterChanged();
      });
    });

    // The crest lines are drawn over the surface rather than into it, so these
    // two restroke and leave the shading alone — no reason to make them wait.
    $('water-lines').addEventListener('change', function () {
      state.waterLines = $('water-lines').checked;
      $('water-line-rows').hidden = !state.waterLines;
      repaint();
    });

    $('water-weight').addEventListener('input', function () {
      state.waterWeight = parseFloat($('water-weight').value);
      $('water-weight-val').textContent = fixed(state.waterWeight, 1) + '×';
      repaint();
    });

    /* ------------------------------------------------------------ lettering */

    $('text-on').addEventListener('change', function () {
      state.textOn = $('text-on').checked;
      $('text-panel').hidden = !state.textOn;
      repaint();
    });

    // Typing is the one control here that fires per keystroke, and a repaint
    // lays out every letter on the map. A short wait costs nothing and saves
    // doing that work for each half-typed word.
    var wordsDebounce = null;
    $('text-words').addEventListener('input', function () {
      state.textWords = $('text-words').value;
      syncWordCount();
      clearTimeout(wordsDebounce);
      wordsDebounce = setTimeout(repaint, 150);
    });

    $('text-caps').addEventListener('change', function () {
      state.textCaps = $('text-caps').checked;
      repaint();
    });

    $('text-size').addEventListener('input', function () {
      state.textSize = parseFloat($('text-size').value);
      $('text-size-val').textContent = fixed(state.textSize, 1);
      repaint();
    });

    $('text-weight').addEventListener('input', function () {
      state.textWeight = parseInt($('text-weight').value, 10);
      $('text-weight-val').textContent = state.textWeight;
      repaint();
    });

    $('text-tracking').addEventListener('input', function () {
      state.textTracking = parseFloat($('text-tracking').value);
      $('text-tracking-val').textContent = fixed(state.textTracking, 2) + ' em';
      repaint();
    });

    $('text-gap').addEventListener('input', function () {
      state.textGap = parseFloat($('text-gap').value);
      $('text-gap-val').textContent = fixed(state.textGap, 1) + ' em';
      repaint();
    });

    $('text-keep-lines').addEventListener('change', function () {
      state.textKeepLines = $('text-keep-lines').checked;
      repaint();
    });

    /* --------------------------------------------------------------- border */

    $('border-on').addEventListener('change', function () {
      state.borderOn = $('border-on').checked;
      $('border-rows').hidden = !state.borderOn;
      repaint();
    });

    $('border-width').addEventListener('input', function () {
      state.borderWidth = parseFloat($('border-width').value);
      $('border-width-val').textContent = fixed(state.borderWidth, 1);
      repaint();
    });

    $('border-ink').addEventListener('input', function () {
      state.borderInk = $('border-ink').value;
      repaint();
    });

    $('border-match').addEventListener('click', function () {
      state.borderInk = null;
      repaint();
    });

    /* --------------------------------------------------------------- mockup */

    Array.prototype.forEach.call(doc.getElementsByName('view'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.view = radio.value;
        syncMockup();
        // Onto a shirt needs only the shirt drawn: the picture is in hand. Back
        // to flat is a repaint, because #view was last sized while hidden, by
        // a guess at its width rather than a measurement.
        if (isShirt()) paintMockup();
        else paint();
      });
    });

    // Another colour is only another photo under the same print: a redraw of
    // the shirt, and nothing about the picture or its placement moves.
    Array.prototype.forEach.call(doc.getElementsByName('shirt-colour'), function (radio) {
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        state.shirtColour = radio.value;
        syncMockup();
        paintMockup();
      });
    });

    Object.keys(PRINT_FIELDS).forEach(function (id) {
      $(id).addEventListener('input', function () {
        if (!isShirt()) return;
        state.placement[state.view][PRINT_FIELDS[id]] = parseFloat($(id).value) / 100;
        paintMockup();
      });
    });

    $('print-reset').addEventListener('click', function () {
      if (!isShirt()) return;
      var reset = {};
      reset[state.view] = PLACEMENT_DEFAULTS[state.view];
      state.placement = mergePlacement(state.placement, reset);
      paintMockup();
    });

    wireDrag();
    wireTyping();

    $('download-mockup').addEventListener('click', function () {
      downloadMockup().catch(function () { /* already reported in the status line */ });
    });

    $('scale').addEventListener('change', function () {
      state.scale = parseFloat($('scale').value);
      syncExportNote();
    });

    $('download').addEventListener('click', function () {
      download().catch(function () { /* already reported in the status line */ });
    });

    global.addEventListener('resize', function () {
      clearTimeout(debounce);
      debounce = setTimeout(paint, 150);
    });
  }

  /**
   * Drag the print about on the shirt.
   *
   * From wherever the drag starts, not only from on the print: a small print
   * is a small target, and a white one is barely visible. The move is by the
   * pointer's travel, so the print never jumps to meet it, and it stops at the
   * edge of the print area. Redrawn once a frame, however many moves the
   * pointer reports in between.
   */
  function wireDrag() {
    var canvas = $('mockup');
    var drag = null;
    var pending = 0;

    canvas.addEventListener('pointerdown', function (ev) {
      if (!isShirt() || ev.button !== 0) return;
      var place = state.placement[state.view];
      // The room is measured in the canvas's CSS pixels, the units the pointer
      // moves in, so the print keeps pace with it until it meets an edge.
      var rect = printRect(state.view, canvas.clientWidth || 1, canvas.clientHeight || 1);
      drag = {
        id: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        across: place.across,
        down: place.down,
        roomX: rect.roomX,
        roomY: rect.roomY
      };
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add('dragging');
      paintMockup();
      ev.preventDefault();
    });

    canvas.addEventListener('pointermove', function (ev) {
      if (!drag || ev.pointerId !== drag.id || !isShirt()) return;
      var place = state.placement[state.view];
      if (drag.roomX > 0) place.across = clamp(drag.across + (ev.clientX - drag.x) / drag.roomX, 0, 1);
      if (drag.roomY > 0) place.down = clamp(drag.down + (ev.clientY - drag.y) / drag.roomY, 0, 1);
      if (pending) return;
      pending = global.requestAnimationFrame(function () {
        pending = 0;
        paintMockup();
      });
    });

    function end(ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      drag = null;
      canvas.classList.remove('dragging');
      paintMockup();
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  /* ---------------------------------------------------------- typed numbers */

  var NUMBER = /-?(?:\d+\.?\d*|\.\d+)/;

  /**
   * Let the number beside every slider be typed into.
   *
   * A slider is quick but coarse — 0.05 a notch, or one of a thousand places
   * along a logarithmic scale — and some numbers are wanted exactly. So a click
   * on the readout (or Enter on it) swaps it for a box holding its number, and
   * Enter or clicking away sends what was typed through the slider's own input
   * handler: one path for both, so a typed value has every effect a dragged one
   * does. Escape leaves things as they were.
   *
   * Every slider is found by the one convention the page already keeps — its
   * readout's id is its own plus -val — so a slider added later is typeable
   * without being listed here.
   */
  function wireTyping() {
    Array.prototype.forEach.call(doc.querySelectorAll('input[type=range]'), function (slider) {
      var readout = $(slider.id + '-val');
      if (!readout) return;

      // Focusable and announced as a button: a span, not a <button>, because a
      // button inside the <label> would become what the label names in the
      // slider's place.
      readout.classList.add('typeable');
      readout.tabIndex = 0;
      readout.setAttribute('role', 'button');
      readout.title = 'Click to type a value';

      readout.addEventListener('click', function (ev) {
        // Inside a <label>, the click would otherwise go on to the slider.
        ev.preventDefault();
        openTyping(slider, readout);
      });
      readout.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        openTyping(slider, readout);
      });
    });
  }

  /**
   * Swap a readout for a box to type its number into.
   *
   * The box goes in beside the readout, which is hidden rather than emptied:
   * the handlers write readouts as they please — the shirt's are rewritten on
   * every repaint — and would otherwise overwrite the box mid-word. Whatever
   * surrounds the number ("every", "km", "×") stays either side of it, so what
   * the number means is still on screen while it is being replaced.
   */
  function openTyping(slider, readout) {
    if (slider.disabled || readout.hidden) return;

    var shown = readout.textContent;
    var match = shown.match(NUMBER);
    // "off" has no number in it; the slider's own value is what it stands for.
    var start = match ? match[0] : slider.value;
    var name = readout.parentNode.textContent.replace(shown, '').replace(/\s+/g, ' ').trim();

    var box = doc.createElement('span');
    box.className = 'value-edit';
    var input = doc.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = start;
    input.setAttribute('aria-label', name);
    box.appendChild(doc.createTextNode(match ? shown.slice(0, match.index).trim() : ''));
    box.appendChild(input);
    box.appendChild(doc.createTextNode(match ? shown.slice(match.index + start.length).trim() : ''));

    readout.hidden = true;
    readout.parentNode.insertBefore(box, readout.nextSibling);
    input.focus();
    input.select();

    var closed = false;
    function close(keep, refocus) {
      // Removing the box can blur it, and that must not close it twice.
      if (closed) return;
      closed = true;
      box.parentNode.removeChild(box);
      readout.hidden = false;
      // Only an edit is applied. Opening a readout and leaving must change
      // nothing — and re-reading one that shows a rounded figure would.
      if (keep && input.value.trim() !== start) applyTyped(slider, input.value, shown);
      if (refocus) readout.focus();
    }

    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); close(true, true); }
      if (ev.key === 'Escape') { ev.preventDefault(); close(false, true); }
    });
    input.addEventListener('blur', function () { close(true, false); });
  }

  /**
   * Put a typed number into a slider, as if it had been dragged there.
   *
   * Held to the slider's range, since that is what the design is built to
   * draw, but not to its notches: 0.57 stays 0.57, where dragging could only
   * reach 0.55 or 0.6. A slider that steps in whole numbers rounds, because
   * what it counts — lines, columns, a font weight — has no halves. Text that
   * holds no number is ignored, and the readout keeps what it had.
   */
  function applyTyped(slider, typed, shown) {
    var match = typed.replace(/,/g, '.').match(NUMBER);
    if (!match) return;
    var number = parseFloat(match[0]);

    // The one readout not in its slider's units: the slider is a place along a
    // log scale and the readout is a distance, in km or m. A unit typed wins;
    // otherwise the number is in whichever one the readout was showing.
    if (slider.id === 'width') {
      var unit = /km/i.test(typed) ? 1000 : /m/i.test(typed) ? 1 : /km/i.test(shown) ? 1000 : 1;
      setWidth(number * unit);
      syncMap(false);
      schedule();
      return;
    }

    if (parseFloat(slider.step) % 1 === 0) number = Math.round(number);
    number = clamp(number, parseFloat(slider.min), parseFloat(slider.max));

    // Unstepped for as long as the handler takes to read it, so the value
    // arrives as typed and not snapped to the nearest notch. What the thumb
    // does once the step is back is only where it is drawn.
    var step = slider.getAttribute('step');
    slider.step = 'any';
    slider.value = String(number);
    slider.dispatchEvent(new global.Event('input', { bubbles: true }));
    slider.setAttribute('step', step);
  }

  /* ------------------------------------------------------------------- boot */

  /** Push the whole of state into the controls, so the panel never lies. */
  function syncControls() {
    $('lat').value = state.lat.toFixed(5);
    $('lng').value = state.lng.toFixed(5);
    $('q').value = state.place;
    $('width').value = widthToSlider(state.widthM);
    $('width-val').textContent = fmtDistance(state.widthM);
    $('levels').value = state.levels;
    $('levels-val').textContent = state.levels;
    $('weight').value = state.weight;
    $('weight-val').textContent = fixed(state.weight, 1) + '×';
    $('img-w').value = state.imageW;
    $('img-h').value = state.imageH;
    $('margin').value = Math.round(state.margin * 100);
    $('margin-val').textContent = Math.round(state.margin * 100) + '%';
    $('bg').value = state.background;
    $('ink').value = state.ink;
    $('index-every').value = state.indexEvery;
    $('index-every-val').textContent = state.indexEvery ? 'every ' + state.indexEvery : 'off';
    $('index-width').value = state.indexWidth;
    $('index-width-val').textContent = fixed(state.indexWidth, 1) + '×';
    $('index-ink').value = state.indexInk;
    $('index-ink').disabled = !state.indexTint;
    $('tidy').checked = state.tidy;
    $('detail').value = state.detail;
    $('transparent').checked = state.transparent;
    $('bg').disabled = state.transparent;
    $('scale').value = String(state.scale);

    $('text-on').checked = state.textOn;
    $('text-panel').hidden = !state.textOn;
    $('text-words').value = state.textWords;
    $('text-caps').checked = state.textCaps;
    $('text-size').value = state.textSize;
    $('text-size-val').textContent = fixed(state.textSize, 1);
    $('text-weight').value = state.textWeight;
    $('text-weight-val').textContent = state.textWeight;
    $('text-tracking').value = state.textTracking;
    $('text-tracking-val').textContent = fixed(state.textTracking, 2) + ' em';
    $('text-gap').value = state.textGap;
    $('text-gap-val').textContent = fixed(state.textGap, 1) + ' em';
    $('text-keep-lines').checked = state.textKeepLines;
    syncWordCount();

    $('border-on').checked = state.borderOn;
    $('border-rows').hidden = !state.borderOn;
    $('border-width').value = state.borderWidth;
    $('border-width-val').textContent = fixed(state.borderWidth, 1);
    // A followed colour is filled in by the next paint, which knows it.
    if (state.borderInk) $('border-ink').value = state.borderInk;
    $('border-match').disabled = !state.borderInk;

    $('ascii-cols').value = state.asciiCols;
    $('ascii-cols-val').textContent = state.asciiCols;
    $('ascii-ramp').value = state.asciiRamp;
    $('ascii-invert').checked = state.asciiInvert;
    $('ascii-weight').value = state.asciiWeight;
    $('ascii-weight-val').textContent = state.asciiWeight;

    $('word-cols').value = state.wordCols;
    $('word-cols-val').textContent = state.wordCols;
    $('word-list').value = state.wordList;
    $('word-separator').value = state.wordSeparator;
    $('word-caps').checked = state.wordCaps;
    $('word-weight').value = state.wordWeight;
    $('word-weight-val').textContent = state.wordWeight;

    $('water-depth').value = state.waterDepth;
    $('water-depth-val').textContent = fixed(state.waterDepth, 2);
    $('water-sharp').value = state.waterSharp;
    $('water-sharp-val').textContent = fixed(state.waterSharp, 2);
    $('water-wash').value = state.waterWash;
    $('water-wash-val').textContent = fixed(state.waterWash, 2);
    $('water-glint').value = state.waterGlint;
    $('water-glint-val').textContent = fixed(state.waterGlint, 2);
    $('water-realistic').checked = state.waterRealistic;
    $('water-real-rows').hidden = !state.waterRealistic;
    $('water-reflect').value = state.waterReflect;
    $('water-reflect-val').textContent = fixed(state.waterReflect, 2);
    $('water-clarity').value = state.waterClarity;
    $('water-clarity-val').textContent = fixed(state.waterClarity, 2);
    $('water-sky-top').value = state.waterSkyTop;
    $('water-sky-low').value = state.waterSkyLow;
    $('water-lines').checked = state.waterLines;
    $('water-line-rows').hidden = !state.waterLines;
    $('water-weight').value = state.waterWeight;
    $('water-weight-val').textContent = fixed(state.waterWeight, 1) + '×';

    syncDesign();
    syncMockup();

    $('custom-toggle').setAttribute('aria-pressed', String(state.custom));
    $('custom-panel').hidden = !state.custom;
    Array.prototype.forEach.call(doc.getElementsByName('mode'), function (radio) {
      radio.checked = radio.value === state.mode;
    });

    syncColourMode();
    renderStops();
    renderPalettes();
    syncExportNote();
  }

  function boot() {
    renderAspects();
    wire();
    syncControls();

    // Started now rather than when the lettering is first switched on: it is
    // an inlined data URI, so this costs no request and is long since ready by
    // the time the terrain has come down the wire.
    ensureFont();

    $('attribution').textContent = elevation.ATTRIBUTION;

    // Leaflet needs a live network for its basemap; everything else on this
    // page works without one, so a failure here must not stop the tool.
    try {
      picker = Topo.picker.create('map', {
        centre: [state.lat, state.lng],
        zoom: 11,
        onChange: function (centre) { setCentre(centre.lat, centre.lng, false); }
      });
      picker.setCentre(state.lat, state.lng);
    } catch (err) {
      $('map').textContent = 'The map preview could not start (' + err.message +
        '). The coordinate boxes still work.';
    }

    run().then(function () { syncMap(true); });
  }

  /* The test hook, and an honest scripting surface: everything the controls do
   * is a state change plus a rerun, so they are the same two calls. */
  global.TopoTool = {
    state: state,
    setPlace: function (lat, lng, name) {
      if (name) {
        state.place = name;
        $('q').value = name;
      }
      setCentre(lat, lng, true);
      return rerun();
    },
    setDesign: function (changes) {
      if (changes.preset !== undefined) adoptPreset(changes.preset);
      var placement = state.placement;
      Object.keys(changes).forEach(function (key) { state[key] = changes[key]; });
      // Merged rather than replaced, so one side can be moved on its own.
      if (changes.placement) state.placement = mergePlacement(placement, changes.placement);
      if (changes.imageW !== undefined || changes.imageH !== undefined) {
        setImageSize(state.imageW, state.imageH);
      }
      syncControls();
      return rerun();
    },
    render: rerun,
    download: download,
    mockup: downloadMockup,
    geometry: function () { return cache.geometry; },
    // The elevation the picture was made from, for a script that wants to
    // check the picture against the ground rather than take it on trust.
    grid: function () { return cache.grid; }
  };

  /** Run now rather than after the debounce — what a script wants to await. */
  function rerun() {
    clearTimeout(debounce);
    return run();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
