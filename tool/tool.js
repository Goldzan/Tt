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
    tidy: false,

    imageW: 1600,
    imageH: 1200,
    margin: 0.04,

    preset: 'ink',
    custom: false,
    mode: 'solid',
    ink: '#1a1a1a',
    stops: ['#2e4e6e', '#b24c33'],
    background: '#faf9f5',
    transparent: false,

    weight: 1,
    indexEvery: 5,
    indexWidth: 2,
    indexTint: false,
    indexInk: '#b24c33',

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

  function $(id) { return doc.getElementById(id); }

  function fmtDistance(m) {
    return m >= 1000 ? +(m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
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

    var frame = render.frame(size.width, size.height, state.margin);
    status('Rendering ' + size.width + ' × ' + size.height + '…', true);
    progress(0);
    $('download').disabled = true;

    /*
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
    var made = !needsTrace()
      ? Promise.resolve(null)
      : render.trace(cache.grid, frame, {
        levels: state.levels,
        spacing: render.EXPORT_SPACING,
        tidy: state.tidy,
        onProgress: function (done, total) { progress(total ? done / total : 0); }
      });

    return made
      .then(function (result) {
        // The face has to be in hand before the offscreen canvas letters with
        // it; nothing on the page has necessarily rendered it yet.
        return ensureFont().then(function () { return result; });
      })
      .then(function (result) {
        var canvas = render.offscreen(size.width, size.height);
        render.draw(canvas, specFor(size.width, size.height, result));
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
    state.widthM = search.widthForResult(result);
    $('width').value = widthToSlider(state.widthM);
    $('width-val').textContent = fmtDistance(state.widthM);
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
      $('weight-val').textContent = state.weight.toFixed(1) + '×';
      repaint();
    });

    $('index-every').addEventListener('input', function () {
      state.indexEvery = parseInt($('index-every').value, 10) || 0;
      $('index-every-val').textContent = state.indexEvery ? 'every ' + state.indexEvery : 'off';
      repaint();
    });

    $('index-width').addEventListener('input', function () {
      state.indexWidth = parseFloat($('index-width').value);
      $('index-width-val').textContent = state.indexWidth.toFixed(1) + '×';
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
      $('water-depth-val').textContent = state.waterDepth.toFixed(2);
      waterChanged();
    });

    $('water-sharp').addEventListener('input', function () {
      state.waterSharp = parseFloat($('water-sharp').value);
      $('water-sharp-val').textContent = state.waterSharp.toFixed(2);
      waterChanged();
    });

    $('water-wash').addEventListener('input', function () {
      state.waterWash = parseFloat($('water-wash').value);
      $('water-wash-val').textContent = state.waterWash.toFixed(2);
      waterChanged();
    });

    $('water-glint').addEventListener('input', function () {
      state.waterGlint = parseFloat($('water-glint').value);
      $('water-glint-val').textContent = state.waterGlint.toFixed(2);
      waterChanged();
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
      $('water-weight-val').textContent = state.waterWeight.toFixed(1) + '×';
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
      $('text-size-val').textContent = state.textSize.toFixed(1);
      repaint();
    });

    $('text-weight').addEventListener('input', function () {
      state.textWeight = parseInt($('text-weight').value, 10);
      $('text-weight-val').textContent = state.textWeight;
      repaint();
    });

    $('text-tracking').addEventListener('input', function () {
      state.textTracking = parseFloat($('text-tracking').value);
      $('text-tracking-val').textContent = state.textTracking.toFixed(2) + ' em';
      repaint();
    });

    $('text-gap').addEventListener('input', function () {
      state.textGap = parseFloat($('text-gap').value);
      $('text-gap-val').textContent = state.textGap.toFixed(1) + ' em';
      repaint();
    });

    $('text-keep-lines').addEventListener('change', function () {
      state.textKeepLines = $('text-keep-lines').checked;
      repaint();
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
    $('weight-val').textContent = state.weight.toFixed(1) + '×';
    $('img-w').value = state.imageW;
    $('img-h').value = state.imageH;
    $('margin').value = Math.round(state.margin * 100);
    $('margin-val').textContent = Math.round(state.margin * 100) + '%';
    $('bg').value = state.background;
    $('ink').value = state.ink;
    $('index-every').value = state.indexEvery;
    $('index-every-val').textContent = state.indexEvery ? 'every ' + state.indexEvery : 'off';
    $('index-width').value = state.indexWidth;
    $('index-width-val').textContent = state.indexWidth.toFixed(1) + '×';
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
    $('text-size-val').textContent = state.textSize.toFixed(1);
    $('text-weight').value = state.textWeight;
    $('text-weight-val').textContent = state.textWeight;
    $('text-tracking').value = state.textTracking;
    $('text-tracking-val').textContent = state.textTracking.toFixed(2) + ' em';
    $('text-gap').value = state.textGap;
    $('text-gap-val').textContent = state.textGap.toFixed(1) + ' em';
    $('text-keep-lines').checked = state.textKeepLines;
    syncWordCount();

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
    $('water-depth-val').textContent = state.waterDepth.toFixed(2);
    $('water-sharp').value = state.waterSharp;
    $('water-sharp-val').textContent = state.waterSharp.toFixed(2);
    $('water-wash').value = state.waterWash;
    $('water-wash-val').textContent = state.waterWash.toFixed(2);
    $('water-glint').value = state.waterGlint;
    $('water-glint-val').textContent = state.waterGlint.toFixed(2);
    $('water-lines').checked = state.waterLines;
    $('water-line-rows').hidden = !state.waterLines;
    $('water-weight').value = state.waterWeight;
    $('water-weight-val').textContent = state.waterWeight.toFixed(1) + '×';

    syncDesign();

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
      Object.keys(changes).forEach(function (key) { state[key] = changes[key]; });
      if (changes.imageW !== undefined || changes.imageH !== undefined) {
        setImageSize(state.imageW, state.imageH);
      }
      syncControls();
      return rerun();
    },
    render: rerun,
    download: download,
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
