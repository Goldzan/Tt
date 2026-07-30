/*
 * map.js — the "basic map" centre picker.
 *
 * Click anywhere to move the centre, or drag the pin. The 4:3 box that will be
 * rendered is drawn around it, using the bounding box the app computes — so
 * what the rectangle shows and what gets generated can never drift apart.
 *
 * The coordinate inputs stay in sync both ways, which keeps the tool fully
 * usable when tile images can't load (restricted network, offline, corporate
 * proxy): the pin, the box and the readouts all work regardless.
 */
(function (global) {
  'use strict';

  var Topo = global.Topo || (global.Topo = {});
  var L = global.L;

  var BASEMAPS = {
    osm: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    },
    // Shaded relief from the same host as the elevation data, so if the
    // elevation tiles reach you, this basemap does too.
    terrain: {
      url: 'https://s3.amazonaws.com/elevation-tiles-prod/normal/{z}/{x}/{y}.png',
      options: {
        maxZoom: 15,
        attribution: 'Relief © <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>'
      }
    }
  };

  function centreIcon() {
    return L.divIcon({
      className: '',
      html: '<div class="pin"><span></span></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
  }

  function create(elementId, options) {
    options = options || {};
    var onChange = options.onChange || function () {};

    var map = L.map(elementId, { zoomControl: true, worldCopyJump: true }).setView(
      options.centre || [46.8523, -121.7603],
      options.zoom || 11
    );

    var tileLayer = null;
    var centre = null; // L.LatLng
    var marker = null;
    var rect = null;

    function setBasemap(name) {
      if (tileLayer) {
        map.removeLayer(tileLayer);
        tileLayer = null;
      }
      var spec = BASEMAPS[name];
      if (spec) tileLayer = L.tileLayer(spec.url, spec.options).addTo(map);
    }

    function drawPin() {
      if (!centre) {
        if (marker) {
          map.removeLayer(marker);
          marker = null;
        }
        return;
      }
      if (marker) {
        marker.setLatLng(centre);
        return;
      }
      marker = L.marker(centre, {
        icon: centreIcon(),
        draggable: true,
        keyboard: false
      }).addTo(map);
      marker.on('drag', function (ev) {
        centre = ev.target.getLatLng();
        onChange(getCentre());
      });
    }

    /** Draw the area that will actually be rendered. */
    function setBox(bbox) {
      if (!bbox) {
        if (rect) {
          map.removeLayer(rect);
          rect = null;
        }
        return;
      }
      var bounds = L.latLngBounds(
        L.latLng(bbox.south, bbox.west),
        L.latLng(bbox.north, bbox.east)
      );
      if (rect) {
        rect.setBounds(bounds);
      } else {
        rect = L.rectangle(bounds, {
          color: '#6ea8fe',
          weight: 1.5,
          fillColor: '#6ea8fe',
          fillOpacity: 0.12,
          interactive: false
        }).addTo(map);
      }
    }

    map.on('click', function (ev) {
      centre = ev.latlng;
      drawPin();
      onChange(getCentre());
    });

    function getCentre() {
      return centre ? { lat: centre.lat, lng: centre.lng } : null;
    }

    function setCentre(lat, lng) {
      centre = isFinite(lat) && isFinite(lng) ? L.latLng(lat, lng) : null;
      drawPin();
    }

    /** Zoom to the rendered area, with a margin so the frame stays visible. */
    function fitBox(bbox) {
      if (!bbox) return;
      map.fitBounds(
        L.latLngBounds(L.latLng(bbox.south, bbox.west), L.latLng(bbox.north, bbox.east)).pad(0.3)
      );
    }

    setBasemap(options.basemap || 'osm');

    return {
      map: map,
      setBasemap: setBasemap,
      setCentre: setCentre,
      getCentre: getCentre,
      setBox: setBox,
      fitBox: fitBox,
      invalidate: function () {
        map.invalidateSize();
      }
    };
  }

  Topo.picker = { create: create, BASEMAPS: BASEMAPS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
