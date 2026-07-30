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
      every: state.indexEvery,
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
    if (!cache.grid || !cache.result) {
      $('stats').textContent = '';
      return;
    }
    var plan = cache.plan;
    var result = cache.result;
    $('stats').textContent = [
      Math.round(cache.grid.min) + '–' + Math.round(cache.grid.max) + ' m',
      result.interval ? Math.round(result.interval) + ' m between lines' : '',
      result.pathCount + ' paths',
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

      terrain = elevation.fetchGrid(plan, {
        signal: terrainAbort.signal,
        onProgress: function (done, total) {
          if (live()) progress(total ? (done / total) * 0.5 : 0);
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
    return state.place + ' · ' + fmtDistance(state.widthM) + ' across · ' +
      state.levels + ' lines · ' + size.width + ' × ' + size.height + ' px';
  }

  /* ---------------------------------------------------------------- painting */

  /**
   * Repaint from cached geometry. This is the cheap path: colours, thickness
   * and index settings all end here without touching the network or the tracer.
   */
  function paint() {
    if (!cache.result) return;

    var design = designFrame();
    var spec = render.geometry(cache.result, palette(), design.width, design.height, {
      weight: state.weight,
      transparent: state.transparent
    });
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

    return render.trace(cache.grid, frame, {
      levels: state.levels,
      spacing: render.EXPORT_SPACING,
      tidy: state.tidy,
      onProgress: function (done, total) { progress(total ? done / total : 0); }
    })
      .then(function (result) {
        var canvas = render.offscreen(size.width, size.height);
        render.draw(canvas, render.geometry(result, palette(), size.width, size.height, {
          weight: state.weight,
          transparent: state.transparent
        }));
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
    status(describe(), false);
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
    geometry: function () { return cache.geometry; }
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
