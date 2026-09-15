/*
 * tool-presets.js — premade designs: every setting on the page, chosen ahead.
 *
 * A premade design is one JSON file in presets/, and build-tool.js folds all of
 * them into the page as Topo.presetFiles, because the built file opens off a
 * disk and is not allowed to fetch the files beside it. What a file holds is
 * the tool's own state, by the names TopoTool.state uses — so the way to make
 * one is to set the panel up and save it, not to write it by hand.
 *
 * A file need not name everything. A setting it leaves out goes back to the
 * page's default when the design is picked, so a premade design looks the same
 * whatever was on screen before it — except the place, which stays where it
 * was. A file with no place in it is a style to put on any mountain.
 *
 * Nothing here knows the settings by name beyond those two lists. A file is
 * checked against the page's defaults, key by key and kind by kind, so a
 * setting added to the tool later can be preset without being listed here.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});

  /* Not part of a design: which view the stage shows, and how the download is
   * sized and named. */
  var SKIP = ['view', 'scale', 'filename'];

  /* Where the map is, rather than what it looks like. Left out of a file, these
   * keep whatever the page has. */
  var PLACE = ['lat', 'lng', 'place', 'widthM', 'captionName'];

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function isColour(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  }

  function isPlace(key) { return PLACE.indexOf(key) !== -1; }

  /** Can this setting be held in a preset at all? */
  function presettable(key, defaults) {
    return Object.prototype.hasOwnProperty.call(defaults, key) && SKIP.indexOf(key) === -1;
  }

  /**
   * What `value` would have to be to stand in for `standard`, the page's
   * default for the same setting — or null if it already can.
   *
   * Judged by the default's kind. A colour picker handed anything but #rrggbb
   * quietly shows black, so a default that is a colour asks for one; a null
   * default is an ink that follows the map until one is picked, so it takes a
   * colour or null.
   */
  function problem(value, standard) {
    if (standard === null) {
      return value === null || isColour(value) ? null : 'a colour like "#1a1a1a", or null';
    }
    if (Array.isArray(standard)) {
      var item = standard.length ? standard[0] : value && value[0];
      return Array.isArray(value) && value.length &&
        value.every(function (each) { return !problem(each, item); })
        ? null : 'a list like ' + JSON.stringify(standard);
    }
    if (isColour(standard)) return isColour(value) ? null : 'a colour like "#1a1a1a"';
    if (typeof standard === 'number') {
      return typeof value === 'number' && isFinite(value) ? null : 'a number';
    }
    if (typeof standard === 'object') {
      return value && typeof value === 'object' && !Array.isArray(value) ? null : 'an object';
    }
    return typeof value === typeof standard ? null : 'a ' + typeof standard;
  }

  /**
   * A preset file, checked against the page's defaults.
   *
   * `choices` names the settings that must be one of a list — the design, a
   * palette id — since a string of the right kind can still name nothing.
   * Each problem found costs one setting, never the whole file: a file written
   * for a later version of the tool still gives everything it can.
   */
  function read(data, id, defaults, choices) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { preset: null, problems: ['it is not a JSON object'] };
    }

    var problems = [];
    var given = data.settings;
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      problems.push('it has no "settings" object');
      given = {};
    }

    var settings = {};
    Object.keys(given).forEach(function (key) {
      if (!presettable(key, defaults)) {
        problems.push(key + ' is not a setting a preset can hold');
        return;
      }
      var wrong = problem(given[key], defaults[key]);
      if (!wrong && choices && choices[key] && choices[key].indexOf(given[key]) === -1) {
        wrong = 'one of ' + choices[key].join(', ');
      }
      if (wrong) {
        problems.push(key + ' should be ' + wrong);
        return;
      }
      settings[key] = clone(given[key]);
    });

    return {
      preset: {
        id: id,
        name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : id,
        description: typeof data.description === 'string' ? data.description.trim() : '',
        settings: settings,
        hasPlace: PLACE.some(function (key) { return key in settings; })
      },
      problems: problems
    };
  }

  /**
   * Every presettable setting, as the page should be once this preset is
   * picked: the file's own values, the defaults for whatever it leaves out,
   * and `current`'s place where it gives none. Copies throughout, so nothing
   * done to the page afterwards can edit the preset.
   */
  function resolve(preset, defaults, current) {
    var out = {};
    Object.keys(defaults).forEach(function (key) {
      if (!presettable(key, defaults)) return;
      out[key] = clone(key in preset.settings ? preset.settings[key]
        : isPlace(key) ? current[key] : defaults[key]);
    });
    return out;
  }

  /**
   * The page's settings as the contents of a preset file. Every one of them,
   * in the state's own order — so two files diff cleanly and a design keeps
   * its look even if the page's defaults change later.
   */
  function write(state, name, withPlace) {
    var settings = {};
    Object.keys(state).forEach(function (key) {
      if (!presettable(key, state) || (!withPlace && isPlace(key))) return;
      settings[key] = clone(state[key]);
    });
    return { name: name, description: '', settings: settings };
  }

  /** The files build-tool.js found in presets/, as { id, data }, in name order. */
  function files() {
    return Array.isArray(Topo.presetFiles) ? Topo.presetFiles : [];
  }

  Topo.designPresets = {
    SKIP: SKIP,
    PLACE: PLACE,
    clone: clone,
    isPlace: isPlace,
    read: read,
    resolve: resolve,
    write: write,
    files: files
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
