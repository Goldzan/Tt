/*
 * ascii.js — the elevation grid as characters.
 *
 * The other design in this tool draws lines between heights. This one draws the
 * heights themselves: the ground is binned into a grid of character cells and
 * each cell gets a character off a ramp, densest on the low ground and lightest
 * on the high. What carries the relief is how much ink a character puts on the
 * page, so the whole picture is one size of one monospaced face and only the
 * choice of character changes.
 *
 * Two things here are worth knowing about:
 *
 * 1. The row count is derived from the column count, and not by the picture's
 *    shape alone. A character cell is about 0.6 as wide as it is tall, so a grid
 *    of square cells would stand the map up on end. rowsFor is what keeps the
 *    ground the right shape while the letters keep theirs.
 *
 * 2. Cells are box averages of the elevation grid, not point samples. The grid
 *    is far finer than the character grid — hundreds of samples across against
 *    tens of characters — and picking one sample per cell would throw away the
 *    other forty and shimmer as the picture resizes.
 *
 * No DOM references, so Node can require() this and check the binning without a
 * canvas.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  /*
   * The default ramp, densest first: low ground is heavy, high ground is light.
   *
   * It reads as the inverse of the usual terminal-art ramp, where the dense
   * characters stand for darkness. Here they stand for depth — the valleys are
   * where the ink collects. A trailing space is a legal ramp character and
   * makes the summits fade out to nothing, which is worth knowing but not worth
   * defaulting to.
   */
  var RAMP = '@%#*+=-:.';

  /*
   * Advance width over em for a monospaced face, used until something has
   * measured the real one. Source Code Pro is 0.6 exactly; the point of
   * measuring anyway is that a browser which never loaded it falls back to
   * whatever monospace it has, and that face's advance decides where the
   * columns land.
   */
  var ADVANCE = 0.6;

  /**
   * The ramp control, parsed.
   *
   * Array.from rather than split(''), so a ramp typed with block characters or
   * anything else outside the basic plane counts each one once instead of
   * splitting it into halves that render as tofu.
   */
  function ramp(text) {
    var chars = Array.from(String(text === undefined || text === null ? '' : text));
    return chars.length ? chars : Array.from(RAMP);
  }

  /**
   * How many rows of characters go with this many columns.
   *
   * The cells have to tile the map exactly, and the characters in them have to
   * keep their natural proportions — so the cell is as wide as a character
   * advance and as tall as a line, and the row count falls out of that:
   *
   *   (area.w / cols) / (area.h / rows) = advance   ->   rows = advance * cols * area.h / area.w
   *
   * At 100 columns on a 4:3 picture that is 45 rows. Deriving rows from the
   * aspect alone would give 75, and every hill would come out stretched.
   */
  function rowsFor(cols, area, advance) {
    var ratio = advance > 0 ? advance : ADVANCE;
    if (!(cols > 0) || !(area.w > 0) || !(area.h > 0)) return 1;
    return Math.max(1, Math.round((ratio * cols * area.h) / area.w));
  }

  /**
   * Bin the elevation grid down to cols x rows, and pick a ramp step for each.
   *
   * Returns { values, min, max, index } — the mean height per cell, the range
   * those means cover, and the ramp position per cell as a Uint8Array, both in
   * row-major order to match the grid.
   */
  function cells(grid, cols, rows, steps) {
    var W = grid.width;
    var H = grid.height;
    var data = grid.data;
    var values = new Float32Array(cols * rows);
    var min = Infinity;
    var max = -Infinity;

    for (var r = 0; r < rows; r++) {
      // Each cell owns a block of the grid. The bounds are computed from the
      // cell index rather than accumulated, so rounding cannot drift a column
      // out of step by the far side of a wide picture.
      var y0 = Math.floor((r * H) / rows);
      var y1 = Math.max(y0 + 1, Math.floor(((r + 1) * H) / rows));
      if (y1 > H) y1 = H;

      for (var c = 0; c < cols; c++) {
        var x0 = Math.floor((c * W) / cols);
        var x1 = Math.max(x0 + 1, Math.floor(((c + 1) * W) / cols));
        if (x1 > W) x1 = W;

        var sum = 0;
        var n = 0;
        for (var j = y0; j < y1; j++) {
          var row = j * W;
          for (var i = x0; i < x1; i++) {
            sum += data[row + i];
            n++;
          }
        }

        var mean = n > 0 ? sum / n : 0;
        values[r * cols + c] = mean;
        if (mean < min) min = mean;
        if (mean > max) max = mean;
      }
    }

    if (!isFinite(min) || !isFinite(max)) {
      min = 0;
      max = 0;
    }

    return { values: values, min: min, max: max, index: indices(values, min, max, steps) };
  }

  /**
   * Ramp position per cell, from the cell heights.
   *
   * Normalised against the range of the *cell* means rather than the grid's own
   * min and max. Averaging pulls the extremes in — the highest cell is a mean
   * over a block that included lower ground — so normalising against the grid
   * would leave both ends of the ramp unused and wash the picture out. Against
   * the cells' own range, the densest and lightest characters both appear.
   *
   * Flat ground is a picture here, unlike a contour map, which has nothing to
   * draw when nothing varies. It comes out as one character everywhere.
   */
  function indices(values, min, max, steps) {
    var n = Math.max(1, steps | 0);
    var out = new Uint8Array(values.length);
    var span = max - min;

    for (var i = 0; i < values.length; i++) {
      var t = span > 0 ? (values[i] - min) / span : 0;
      var step = Math.floor(t * n);
      out[i] = step < 0 ? 0 : step > n - 1 ? n - 1 : step;
    }

    return out;
  }

  Topo.ascii = {
    RAMP: RAMP,
    ADVANCE: ADVANCE,
    ramp: ramp,
    rowsFor: rowsFor,
    cells: cells,
    indices: indices
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Topo.ascii;
})(typeof globalThis !== 'undefined' ? globalThis : this);
