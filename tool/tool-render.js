/*
 * tool-render.js — contours to pixels.
 *
 * The picture is composed in a canonical 1000-unit-wide frame, exactly as
 * server/render.js does, and drawn at whatever size is being asked for. That is
 * what makes the preview on screen and the 4000 px download the same picture at
 * two scales rather than two pictures: line weights are expressed against the
 * canonical width and scaled, and the traced geometry is regenerated at the
 * output size so curves are smooth there instead of being an enlargement of the
 * preview's facets.
 *
 * No DOM controls here — this file takes an elevation grid and some numbers and
 * gives back geometry, a painted canvas, or a PNG.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  // The frame line weights are written against, the same constant the print
  // renderer uses. A weight of 1 means "1 unit wide on a 1000-wide picture".
  var DESIGN_WIDTH = 1000;

  // Vertex spacing in output units, from server/render.js: fine enough on
  // screen that curves do not show their facets on a 2x display, finer still
  // for a file that may be printed.
  var PREVIEW_SPACING = 1.5;
  var EXPORT_SPACING = 2.5;

  // Closed rings narrower than this fraction of the map's width are specks the
  // elevation data threw up rather than features. server/design.js calls the
  // same number TIDY_MIN_LOOP.
  var TIDY_MIN_LOOP = 0.008;

  /*
   * A ceiling on the letters in one picture. Text is laid out on every repaint,
   * and a small enough size on a dense enough map asks for millions of glyphs —
   * which is not a picture anyone wants, but is a locked-up tab. Stopping at a
   * number says the same thing faster, and draw() reports that it did.
   */
  var MAX_GLYPHS = 40000;

  /*
   * How much bigger an index contour's lettering is. The stroke renderer makes
   * those lines indexWidth times heavier; matching that outright would make the
   * words on them twice the size and turn emphasis into a headline, so the
   * square root is taken — 2x the weight becomes 1.4x the lettering.
   */
  function textScaleFor(palette, index) {
    return Math.sqrt(Topo.palettes.widthFor(palette, index, 1));
  }

  /**
   * Where the map sits inside a picture of this size.
   *
   * The margin is a fraction of the shorter side, so a wide picture and a tall
   * one get the same visual border rather than one with a hairline and one with
   * a moat. `aspect` is the map area's own shape — not the picture's — because
   * it is the area the ground has to match: bboxFromCentre is given this, and
   * the terrain arrives already the right shape rather than stretched to fit.
   */
  function frame(width, height, margin) {
    var m = Math.round(Math.min(width, height) * (margin || 0));
    var w = Math.max(1, width - 2 * m);
    var h = Math.max(1, height - 2 * m);
    return { x: m, y: m, w: w, h: h, aspect: w / h };
  }

  /**
   * Group contour layers by colour and weight, the way server/render.js:57
   * does — including passing the user's line thickness in as the palette's base
   * width, so an index contour stays proportionally heavier at every setting.
   *
   * Paths come out as bare coordinate arrays, which is what draw() strokes.
   * Whether one is a ring is not carried alongside them: contour.js closes a
   * ring by repeating its first point, so the array says so itself (isRing).
   */
  function layers(result, palette, outputWidth, weight, textSize) {
    var palettes = Topo.palettes;
    var scale = outputWidth / DESIGN_WIDTH;
    var total = result.layers.length;
    var base = weight || 1;

    return result.layers
      .filter(function (layer) { return layer.paths.length > 0; })
      .map(function (layer) {
        return {
          colour: palettes.inkFor(palette, layer.index, total),
          lineWidth: palettes.widthFor(palette, layer.index, base) * scale,
          // Carried so the lettering can say which line it is and how high it
          // runs, and sized off the same canonical width as the stroke — a
          // 4000 px download has to be the preview enlarged, words and all.
          elevation: layer.elevation,
          index: layer.index,
          fontSize: (textSize || 0) * textScaleFor(palette, layer.index) * scale,
          paths: layer.paths.map(function (path) { return path.points; })
        };
      });
  }

  /** A whole picture: size, background, layers and lettering, ready to draw. */
  function geometry(result, palette, width, height, options) {
    options = options || {};
    var text = options.text || null;
    return {
      kind: 'contour',
      width: width,
      height: height,
      background: options.transparent ? null : (palette.background || null),
      text: text && text.on ? text : null,
      layers: layers(result, palette, width, options.weight, text ? text.size : 0)
    };
  }

  /* --------------------------------------------------------------- ascii */

  /**
   * How wide a character is, as a fraction of its size, in the face the ASCII
   * design is set in.
   *
   * Measured rather than assumed, because a browser that never got Source Code
   * Pro is laying out in whatever monospace it has instead, and that face's
   * advance is what decides how big a character has to be to fill its cell.
   *
   * The size matters to the answer. Browsers round a glyph's advance to whole
   * pixels at small sizes, so the ratio is not the constant a monospaced face
   * suggests: Source Code Pro measures 0.60 at 100px but 0.64 at 8px. Hence the
   * argument — ask at the size you mean to draw at.
   */
  var measurer = null;

  function advanceRatio(size) {
    var at = size > 0 ? size : 100;
    if (!measurer) measurer = offscreen(1, 1).getContext('2d');
    measurer.font = Topo.textpath.font(at, 400);
    var width = measurer.measureText('M').width / at;
    return width > 0 ? width : Topo.ascii.ADVANCE;
  }

  /**
   * The size at which a character fills a cell this wide.
   *
   * Asked at a large size on purpose, which looks like the wrong question —
   * these characters are drawn at ten or twenty units, where the ratio measures
   * noticeably wider. Feeding that measurement back seems more honest and is
   * not: the rounding only happens when a glyph is rasterised, so it depends on
   * the size in *device pixels*, and this spec is in design units that the
   * preview and a 4x download scale differently. There is no one size that
   * satisfies both, and a spec that chased the preview's would quietly change
   * the picture on export.
   *
   * The face's own ratio is the one scale-independent answer, and it lands
   * within a few per cent of the cell at every scale either of them uses —
   * measured at 0.97 to 1.04 across the whole column range. Cells are
   * positioned by arithmetic anyway, so this only decides how snugly the
   * characters sit, never where they are.
   */
  function sizeForCell(cell) {
    return cell / advanceRatio(100);
  }

  /**
   * A whole picture as characters: where the block sits, what is in each cell,
   * and what colour it is.
   *
   * The cell grid is built here rather than cached upstream because it is a
   * box average over a few hundred thousand samples — well under a millisecond,
   * and cheaper than the bookkeeping of another cache stage. That is what keeps
   * every ASCII control on the repaint path.
   */
  /*
   * How many shades of height a colour-carried design uses.
   *
   * Fine enough that a hillside reads as a gradient rather than as terraces,
   * coarse enough that the colours can be worked out once and turned into
   * strings the canvas takes directly. It must stay at or under 256: the tone
   * per cell is kept in a Uint8Array, which would silently wrap above that.
   */
  var TONES = 96;

  /**
   * The measurements every grid-of-characters picture shares: where the block
   * sits, how it divides into cells, and how big a character has to be.
   *
   * The row count comes from the advance ratio at a large size, not at the size
   * the characters will be drawn at. That is deliberate: it is the *shape of
   * the face* the rows have to answer to, and the large-size ratio is the
   * honest measure of that, uncontaminated by the pixel rounding that inflates
   * it at small sizes. Using the drawing size here would quietly change how
   * many rows a picture has when it was exported at four times the scale.
   */
  function cellFrame(width, height, options) {
    var area = frame(width, height, options.margin);
    var cols = Math.max(1, Math.round(options.cols || 100));
    var rows = Topo.ascii.rowsFor(cols, area, advanceRatio(100));
    var cell = area.w / cols;

    return {
      area: area,
      cols: cols,
      rows: rows,
      cellWidth: cell,
      cellHeight: area.h / rows,
      fontSize: sizeForCell(cell)
    };
  }

  /**
   * Colours as the canvas wants them.
   *
   * Built up front, one string per step, for two reasons. It keeps the drawing
   * loop from building a string per cell — tens of thousands of them a frame —
   * and it lets that loop decide whether the colour has actually changed by
   * comparing what it is about to set. A single-ink palette yields the same
   * string at every step, so it sets the fill once for the whole picture.
   */
  function toneStrings(palette, steps, continuous) {
    var out = [];
    for (var i = 0; i < steps; i++) {
      var t = steps > 1 ? i / (steps - 1) : 0;
      out.push(Topo.palettes.css(continuous
        ? Topo.palettes.inkAt(palette, t)
        : Topo.palettes.inkFor(palette, i, steps)));
    }
    return out;
  }

  function asciiGeometry(grid, palette, width, height, options) {
    options = options || {};

    var ascii = Topo.ascii;
    var chars = ascii.ramp(options.ramp);
    if (options.invert) chars = chars.slice().reverse();

    var shape = cellFrame(width, height, options);
    var cells = ascii.cells(grid, shape.cols, shape.rows, chars.length);

    return {
      kind: 'ascii',
      width: width,
      height: height,
      background: options.transparent ? null : (palette.background || null),
      area: shape.area,
      cols: shape.cols,
      rows: shape.rows,
      cellWidth: shape.cellWidth,
      cellHeight: shape.cellHeight,
      fontSize: shape.fontSize,
      weight: options.weight || 400,
      chars: chars,
      // The ramp step doubles as the tone: the character and its colour say the
      // same thing about the ground here.
      tint: cells.index,
      css: toneStrings(palette, chars.length, false),
      cells: cells
    };
  }

  /**
   * A solid block of repeated words, coloured by height.
   *
   * The other way round from the ASCII design: there the character carries the
   * ground and the colour is decoration; here the words are the same wherever
   * you look and the colour is the only thing that knows where the mountain is.
   * Which is why the tones are continuous and taken from inkAt — a palette with
   * a single ink shades that ink rather than giving one flat colour.
   */
  function wordsGeometry(grid, palette, width, height, options) {
    options = options || {};

    var ascii = Topo.ascii;
    var shape = cellFrame(width, height, options);
    var list = ascii.words(options.words);
    if (options.caps) list = list.map(function (word) { return word.toUpperCase(); });

    return {
      kind: 'words',
      width: width,
      height: height,
      background: options.transparent ? null : (palette.background || null),
      area: shape.area,
      cols: shape.cols,
      rows: shape.rows,
      cellWidth: shape.cellWidth,
      cellHeight: shape.cellHeight,
      fontSize: shape.fontSize,
      weight: options.weight || 400,
      text: ascii.stream(list, options.separator, shape.cols * shape.rows),
      tint: ascii.cells(grid, shape.cols, shape.rows, TONES).index,
      css: toneStrings(palette, TONES, true)
    };
  }

  /* --------------------------------------------------------------- water */

  /*
   * The shaded surface, kept between repaints.
   *
   * One entry, because only one is ever wanted: the picture on screen. The
   * shading is a pass over every sample of the elevation grid — three quarters
   * of a million of them at the High detail setting, twenty or thirty
   * milliseconds — which is the same order as the character designs already pay
   * on the repaint path, so it could just be redone each time.
   *
   * It is kept anyway, for a reason those designs do not have: the crest lines
   * are drawn over the surface rather than into it, so switching them off or
   * changing their thickness leaves the water underneath exactly as it was.
   * Without this, restroking a hairline would pay thirty milliseconds to redraw
   * an identical wash.
   */
  var surfaceMemo = { key: '', canvas: null };

  /* Enough of a palette to tell one from another. The colours are what the
   * wash is made of, so a memo that ignored them would leave yesterday's
   * colour on screen — the exact failure the tool's caches exist to avoid, in
   * the other direction. */
  function paletteKey(palette) {
    return [
      (palette.ramp || []).join(';'),
      (palette.ink || []).join(','),
      (palette.background || []).join(',')
    ].join('|');
  }

  /**
   * The water surface as a canvas at the elevation grid's own resolution.
   *
   * At the grid's resolution and at nothing else — this canvas does not know
   * how big the picture is. That is what makes the preview and the 4000 px
   * download share one: the same pixels are stretched over the map rectangle at
   * both sizes, so their agreement is a fact rather than a hope.
   *
   * `key` is the caller's own name for the terrain, because tool.js already
   * keeps one. Fingerprinting the grid here instead would mean hashing three
   * quarters of a million floats, which costs more than redoing the shading it
   * was meant to save.
   */
  function surfaceCanvas(grid, palette, options) {
    var key = [options.key, grid.width, grid.height, paletteKey(palette),
      options.base, options.interval, options.depth, options.sharp,
      options.wash, options.glint, options.reflect, options.clarity,
      (options.skyZenith || []).join(','), (options.skyHorizon || []).join(',')].join('|');

    if (surfaceMemo.key === key && surfaceMemo.canvas) return surfaceMemo.canvas;

    var shaded = Topo.water.surface(grid, {
      tint: function (t) { return Topo.palettes.inkAt(palette, t); },
      base: options.base,
      interval: options.interval,
      depth: options.depth,
      sharp: options.sharp,
      wash: options.wash,
      glint: options.glint,
      reflect: options.reflect,
      clarity: options.clarity,
      skyZenith: options.skyZenith,
      skyHorizon: options.skyHorizon
    });

    var canvas = offscreen(grid.width, grid.height);
    var ctx = canvas.getContext('2d');
    // createImageData and set() rather than the ImageData constructor: the
    // constructor is fine everywhere current, and this is the form the rest of
    // this file's conservatism would have picked anyway.
    var image = ctx.createImageData(grid.width, grid.height);
    image.data.set(shaded.data);
    ctx.putImageData(image, 0, 0);

    surfaceMemo = { key: key, canvas: canvas };
    return canvas;
  }

  /**
   * A whole picture as water: a surface rippling one crest per contour, and the
   * contours themselves drawn along the tops of those crests.
   *
   * Takes the traced contours *and* the grid they came from, which no other
   * design needs. The two are not independent, which is the point of the whole
   * design: the surface is a wave in height, so its crests fall on the levels
   * the tracer used, and the lines are drawn exactly where they were traced
   * because that is exactly where the shading has raised the water.
   */
  function waterGeometry(result, grid, palette, width, height, options) {
    options = options || {};

    var palettes = Topo.palettes;
    var scale = width / DESIGN_WIDTH;
    var total = result.layers.length;
    var wash = options.wash === undefined ? 0.25 : options.wash;

    // The tracer's own levels, passed on so the crests are put where the lines
    // are rather than somewhere this file worked out for itself.
    var shading = {
      key: options.key,
      base: result.levels && result.levels.length ? result.levels[0] : grid.min,
      interval: result.interval,
      depth: options.depth,
      sharp: options.sharp,
      wash: wash,
      glint: options.glint,
      reflect: options.reflect,
      clarity: options.clarity,
      skyZenith: options.skyZenith,
      skyHorizon: options.skyHorizon
    };

    var layers = result.layers
      .filter(function (layer) { return layer.paths.length > 0; })
      .map(function (layer) {
        /*
         * The colour of the water at this level, then brightened hard.
         *
         * A crest line has to be lighter than the crest it sits on, or it reads
         * as a crack in the water rather than as the light catching the top of
         * a wave — and taking the tone straight from the same height as the
         * surface below it would make it exactly as bright as its background
         * and disappear. The wash factor is the surface's own, so the line
         * lightens the water it actually crowns and not some other height's.
         */
        var u = total > 1 ? layer.index / (total - 1) : 0;
        var ink = palettes.inkAt(palette, 0.5 + wash * (u - 0.5));

        return {
          colour: palettes.blend(ink, [255, 255, 255], 0.65),
          elevation: layer.elevation,
          index: layer.index,
          // Undisplaced. The ridge is already here.
          paths: layer.paths.map(function (path) { return path.points; })
        };
      });

    return {
      kind: 'water',
      width: width,
      height: height,
      background: options.transparent ? null : (palette.background || null),
      area: frame(width, height, options.margin),
      surface: surfaceCanvas(grid, palette, shading),
      lines: options.lines !== false,
      lineWidth: (options.weight || 1) * scale,
      lineAlpha: 0.85,
      layers: layers
    };
  }

  /**
   * Paint the character grid.
   *
   * Every cell is placed by arithmetic and drawn on its own. Handing a whole
   * row to one fillText would be faster and is the obvious thing to try with a
   * monospaced face — but the browser rounds a glyph's advance to whole pixels
   * at small sizes, so a row of a hundred characters lands several cells wide
   * of where the grid says it should, and the picture creeps out of its margin.
   * Positioning each one costs a call and owes the font nothing.
   *
   * Centred in the cell rather than hung off its left edge, so a ramp of
   * characters with different widths — which most ramps are, once a browser has
   * rounded them — still reads as a straight column.
   */
  function drawCells(ctx, spec, charAt) {
    var half = spec.cellWidth / 2;
    var colour = null;
    var drawn = 0;

    ctx.font = Topo.textpath.font(spec.fontSize, spec.weight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (var r = 0; r < spec.rows; r++) {
      var y = spec.area.y + (r + 0.5) * spec.cellHeight;
      var row = r * spec.cols;

      for (var c = 0; c < spec.cols; c++) {
        var i = row + c;
        var want = spec.css[spec.tint[i]];

        // Set only on a change. Compared by what is about to be set rather than
        // by the tone number, so a single-ink palette — whose every tone is the
        // same string — assigns the fill once for the whole picture, while a
        // graded one pays only where the colour really moves.
        if (want !== colour) {
          colour = want;
          ctx.fillStyle = want;
        }

        ctx.fillText(charAt(i), spec.area.x + c * spec.cellWidth + half, y);
        drawn++;
      }
    }

    return drawn;
  }

  /**
   * Is this path a closed ring? contour.js repeats the first point to close
   * one, and resample() is careful to finish exactly on the original endpoint,
   * so this is an equality test rather than a guess. The tolerance is there for
   * the arithmetic, not for the data.
   */
  function isRing(points) {
    var n = points.length;
    return n >= 6 &&
      Math.abs(points[0] - points[n - 2]) < 1e-9 &&
      Math.abs(points[1] - points[n - 1]) < 1e-9;
  }

  /**
   * Draw one layer's contours as words instead of as a stroke.
   *
   * The phrase is measured once for the whole layer — every path on a level
   * says the same thing, and measuring per path would repeat that work a
   * thousand times over. Each glyph is then placed by its own midpoint and
   * rotated to the tangent there, which is what makes the sentence bend with
   * the ground instead of stepping around it.
   */
  function letter(ctx, layer, text, place, budget, space) {
    var textpath = Topo.textpath;
    var size = layer.fontSize;
    if (!(size > 0)) return { drawn: 0, clipped: false };
    if (budget <= 0) return { drawn: 0, clipped: true };

    var phrase = textpath.resolve(
      textpath.phraseFor(text.phrases, layer.index),
      { place: place, elevation: layer.elevation, index: layer.index }
    );
    if (text.caps) phrase = phrase.toUpperCase();
    if (!phrase) return { drawn: 0, clipped: false };

    ctx.font = textpath.font(size, text.weight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = Topo.palettes.css(layer.colour);

    var width = textpath.widths(function (ch) { return ctx.measureText(ch).width; });
    var measured = textpath.measurePhrase(phrase, width, text.tracking * size);
    var gap = text.gap * size;
    var drawn = 0;

    for (var i = 0; i < layer.paths.length; i++) {
      // Stopping is reported by the fact of stopping, not by counting up to the
      // ceiling: layout only ever emits whole phrases, so the total lands just
      // under the budget and never on it. Out of room with paths still to go is
      // the thing worth saying.
      if (budget - drawn < measured.glyphs.length) {
        return { drawn: drawn, clipped: true };
      }

      var points = layer.paths[i];
      if (points.length < 4) continue;

      var cum = textpath.cumulative(points);
      var glyphs = textpath.layout(points, cum, measured, {
        closed: isRing(points),
        gap: gap,
        limit: budget - drawn,
        size: size,
        space: space
      });

      for (var g = 0; g < glyphs.length; g++) {
        ctx.save();
        ctx.translate(glyphs[g].x, glyphs[g].y);
        ctx.rotate(glyphs[g].angle);
        ctx.fillText(glyphs[g].char, 0, 0);
        ctx.restore();
      }

      drawn += glyphs.length;
    }

    return { drawn: drawn, clipped: false };
  }

  /**
   * Paint geometry into a canvas at whatever size the canvas is.
   *
   * Round caps and joins are what make a contour end look drawn rather than
   * cut, and they are also why the whole layer is one path: overlapping round
   * joins in a single stroke() do not darken each other.
   *
   * With lettering on, the stroke is what the words replace, so it is drawn
   * only if the picture asked to keep it — underneath, so the words sit on top.
   */
  function drawPicture(canvas, spec) {
    var ctx = canvas.getContext('2d');
    var scale = canvas.width / spec.width;
    var text = spec.text;
    var stroke = !text || text.keepLines;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (spec.background) {
      ctx.fillStyle = Topo.palettes.css(spec.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    var glyphs = 0;
    var clipped = false;

    /*
     * The two designs share the canvas work either side of this — clearing, the
     * background, the one scale that turns design units into pixels, and the
     * count they report back — and part company only over what goes on top.
     */
    if (spec.kind === 'ascii' || spec.kind === 'words') {
      // The two grids of characters differ only in where the character comes
      // from: a ramp step chosen by the height, or the next letter of the words
      // running through the block.
      glyphs = drawCells(ctx, spec, spec.kind === 'ascii'
        ? function (i) { return spec.chars[spec.tint[i]]; }
        : function (i) { return spec.text[i]; });

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      spec.glyphs = glyphs;
      spec.clipped = false;
      return canvas;
    }

    /*
     * Water: the rippling surface first, then the contours along the tops of
     * the crests it has raised.
     *
     * Everything here is in design units, because the one scale() above has
     * already been applied — which is why the surface needs no transform
     * bookkeeping of its own. The same drawImage fills the map rectangle
     * whether this canvas is the preview or the download.
     */
    if (spec.kind === 'water') {
      if (spec.surface) {
        // The only place in this file that enlarges a raster, and the one place
        // smoothing is wanted: the surface is at the elevation grid's
        // resolution, and drawn sharp it would show that grid as a lattice of
        // squares across the water.
        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(spec.surface, spec.area.x, spec.area.y, spec.area.w, spec.area.h);
      }

      if (spec.lines) {
        ctx.globalAlpha = spec.lineAlpha;
        ctx.lineWidth = spec.lineWidth;

        spec.layers.forEach(function (layer) {
          ctx.strokeStyle = Topo.palettes.css(layer.colour);
          ctx.beginPath();
          layer.paths.forEach(function (points) {
            if (points.length < 4) return;
            ctx.moveTo(points[0], points[1]);
            for (var i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
          });
          ctx.stroke();
        });

        // Put back, because only the transform is restored below and this
        // canvas is the same one the next repaint will draw into.
        ctx.globalAlpha = 1;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      spec.glyphs = 0;
      spec.clipped = false;
      return canvas;
    }

    if (stroke) {
      spec.layers.forEach(function (layer) {
        ctx.strokeStyle = Topo.palettes.css(layer.colour);
        ctx.lineWidth = layer.lineWidth;
        ctx.beginPath();
        layer.paths.forEach(function (points) {
          if (points.length < 4) return;
          ctx.moveTo(points[0], points[1]);
          for (var i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
        });
        ctx.stroke();
      });
    }

    if (text) {
      /*
       * One record of where the letters have gone, shared by every layer, so a
       * word keeps clear of the words on the contours either side of it as well
       * as of its own line's. The cell is set off the largest lettering on the
       * page, which is what keeps a neighbour at most one bucket away.
       *
       * Lower ground is lettered first and so has first claim. That is the
       * useful way round: it is the valleys that crowd together on a steep map,
       * and giving the lowest line of a bunched set its words — rather than
       * whichever happened to come last — keeps the labelling of a slope
       * consistent from one picture to the next.
       */
      var biggest = spec.layers.reduce(function (max, layer) {
        return Math.max(max, layer.fontSize);
      }, 0);
      var space = Topo.textpath.occupancy(1.5 * (biggest || 1));

      spec.layers.forEach(function (layer) {
        var set = letter(ctx, layer, text, text.place, MAX_GLYPHS - glyphs, space);
        glyphs += set.drawn;
        clipped = clipped || set.clipped;
      });
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Said out loud rather than left as a mystery: at a small enough size the
    // ceiling stops the lettering part way down the picture, and the only cure
    // is a bigger size or fewer lines.
    spec.glyphs = glyphs;
    spec.clipped = clipped;

    return canvas;
  }

  /* -------------------------------------------------------------- border */

  /**
   * The colour of the outermost line a picture draws: its lowest level.
   *
   * Taken from the spec rather than from the palette, so it is the colour
   * actually on the page — the water design brightens its crest lines, an
   * index contour may have an ink of its own — and a design with no lines
   * answers with its lowest tone instead.
   */
  function outermostInk(spec) {
    if (spec.layers && spec.layers.length) {
      return spec.layers.reduce(function (low, layer) {
        return layer.index < low.index ? layer : low;
      }).colour;
    }
    if (spec.css && spec.css.length) return Topo.palettes.parse(spec.css[0]);
    return [0, 0, 0];
  }

  /**
   * Give a picture a border round its map area, if one is asked for.
   *
   * Any design's spec will do, because the border is the one thing they all
   * draw the same way. The width is in the canonical 1000-wide units the line
   * weights use, so the preview and a 4x download carry the same border at two
   * scales. No colour means the outermost contour's.
   */
  function withBorder(spec, options) {
    if (!options || !options.on || !(options.width > 0)) return spec;
    spec.border = {
      area: frame(spec.width, spec.height, options.margin),
      lineWidth: options.width * (spec.width / DESIGN_WIDTH),
      colour: options.ink || outermostInk(spec)
    };
    return spec;
  }

  /**
   * Stroke the border, last, over whatever the design drew.
   *
   * Inset by half its width, so the whole line lies on the map: centred on
   * the edge, half of it would hang off a picture that has no margin. Mitred,
   * because a frame with rounded corners reads as a sticker.
   */
  function drawBorder(canvas, spec) {
    var border = spec.border;
    var area = border.area;
    var ctx = canvas.getContext('2d');
    var scale = canvas.width / spec.width;
    var half = Math.min(border.lineWidth, area.w, area.h) / 2;

    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = Topo.palettes.css(border.colour);
    ctx.lineWidth = half * 2;
    ctx.strokeRect(area.x + half, area.y + half, area.w - 2 * half, area.h - 2 * half);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** The picture, and then its border if it has one. */
  function draw(canvas, spec) {
    drawPicture(canvas, spec);
    if (spec.border) drawBorder(canvas, spec);
    return canvas;
  }

  /**
   * Trace an elevation grid into the given area of a picture.
   *
   * minLoop is a fraction of the map's width rather than a distance, so the
   * preview and the download drop exactly the same specks instead of merely
   * similar ones.
   */
  function trace(grid, area, options) {
    options = options || {};
    return Topo.contour.generate(
      grid,
      {
        levelCount: options.levels,
        spacing: options.spacing,
        minLoop: options.tidy ? TIDY_MIN_LOOP : 0,
        scaleX: area.w / (grid.width - 1),
        scaleY: area.h / (grid.height - 1),
        offsetX: area.x,
        offsetY: area.y,
        signal: options.signal
      },
      options.onProgress
    );
  }

  /** A detached canvas at an exact pixel size, for rendering the download. */
  function offscreen(width, height) {
    var canvas = global.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Hand a canvas to the browser as a PNG download.
   *
   * toBlob rather than toDataURL: a 4000 px picture is tens of megabytes, and
   * as a data URI that is a string the browser has to hold twice over.
   */
  function toPng(canvas, filename) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error('The browser could not encode a PNG that large. Try a smaller size.'));
          return;
        }
        var url = global.URL.createObjectURL(blob);
        var link = global.document.createElement('a');
        link.href = url;
        link.download = filename;
        global.document.body.appendChild(link);
        link.click();
        link.remove();
        // Revoked on a later turn: Safari has not finished with the URL when
        // click() returns, and a revoked URL downloads nothing.
        global.setTimeout(function () { global.URL.revokeObjectURL(url); }, 60000);
        resolve(blob);
      }, 'image/png');
    });
  }

  Topo.toolRender = {
    DESIGN_WIDTH: DESIGN_WIDTH,
    PREVIEW_SPACING: PREVIEW_SPACING,
    EXPORT_SPACING: EXPORT_SPACING,
    TIDY_MIN_LOOP: TIDY_MIN_LOOP,
    MAX_GLYPHS: MAX_GLYPHS,
    frame: frame,
    layers: layers,
    geometry: geometry,
    asciiGeometry: asciiGeometry,
    wordsGeometry: wordsGeometry,
    waterGeometry: waterGeometry,
    advanceRatio: advanceRatio,
    TONES: TONES,
    isRing: isRing,
    draw: draw,
    withBorder: withBorder,
    trace: trace,
    offscreen: offscreen,
    toPng: toPng
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
