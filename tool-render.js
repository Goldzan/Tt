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
   */
  function layers(result, palette, outputWidth, weight) {
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
          paths: layer.paths.map(function (path) { return path.points; })
        };
      });
  }

  /** A whole picture: size, background and layers, ready to draw. */
  function geometry(result, palette, width, height, options) {
    options = options || {};
    return {
      width: width,
      height: height,
      background: options.transparent ? null : (palette.background || null),
      layers: layers(result, palette, width, options.weight)
    };
  }

  /**
   * Paint geometry into a canvas at whatever size the canvas is.
   *
   * Round caps and joins are what make a contour end look drawn rather than
   * cut, and they are also why the whole layer is one path: overlapping round
   * joins in a single stroke() do not darken each other.
   */
  function draw(canvas, spec) {
    var ctx = canvas.getContext('2d');
    var scale = canvas.width / spec.width;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (spec.background) {
      ctx.fillStyle = Topo.palettes.css(spec.background);
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    frame: frame,
    layers: layers,
    geometry: geometry,
    draw: draw,
    trace: trace,
    offscreen: offscreen,
    toPng: toPng
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
