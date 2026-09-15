# Tt: contour map maker

Turn any mountain into a print-ready picture. Search for a place, choose a style
and colours, and download a PNG, or preview it on a T-shirt first. Everything
runs in your browser: no account, no server, nothing uploaded.

**Use it:** <https://goldzan.github.io/Tt/>

You can also download [`index.html`](index.html) and open it in a browser. It
is one self-contained file, so it works from a USB stick with nothing else
beside it.

## What it makes

The tool reads the height of the ground around a point and draws it in one of
four styles:

| Style | What you see |
|---|---|
| **Contour lines** | Lines of equal height, like a hiking map. Every nth line can be drawn heavier, and the lines can be spelled out in words that follow each curve. |
| **ASCII art** | The heights set as characters: dense characters on low ground, light ones on high ground. |
| **Word block** | A block of repeated words filling the frame. Their colour shows the height. |
| **Water** | The ground shaded as a lit water surface, with every contour the crest of a ripple. |

On top of any style you can choose:

- **Colours:** a built-in palette, or your own single colour or low-to-high
  gradient, on a solid or transparent background.
- **Border and labels:** a line round the map, the place name, its coordinates
  and the Altytude logo.
- **Size and shape:** any pixel size, with shortcuts from phone wallpaper to A3
  poster, plus a margin.
- **T-shirt preview:** the picture on the front or back of a white, blue, green
  or pink shirt. Drag it into place and download a mockup image.
- **Premade designs:** one click sets every setting to a saved design (see
  [Premade designs](#premade-designs)).

The download is a PNG at 1× to 4× the chosen size. Line-based styles are traced
again at the full size, so a 4× file is genuinely sharper rather than an
enlargement.

## How it works

```
 place search  ─►  centre + area  ─►  elevation tiles  ─►  height grid  ─►  design  ─►  canvas  ─►  PNG
 (Nominatim)       (Leaflet map)      (AWS Terrain Tiles)  (in browser)
```

1. **Find the place.** A search goes to OpenStreetMap's Nominatim geocoder, or
   you can drag the pin or type coordinates. The rectangle on the map is exactly
   the area that will be drawn, and its shape follows the picture's shape.
2. **Fetch the terrain.** The page downloads elevation tiles from the free AWS
   Terrain Tiles dataset. Each pixel's colour encodes a height
   (`height = R×256 + G + B/256 − 32768` metres). The browser reads those pixels
   back and assembles them into a grid of heights.
3. **Turn the heights into a design.**
   - *Contour lines* and *Water* trace the grid with marching squares: find
     where the ground crosses each height level, then join the crossings into
     continuous lines.
   - *ASCII art* and *Word block* average the grid into character cells and pick
     each cell's character or colour from its height.
   - *Water* also shades the grid as waves whose crests fall exactly on the
     contour heights.
4. **Paint.** The design is drawn onto a canvas with the chosen colours, border
   and labels, and the browser encodes it as a PNG.

Each step is cached separately, so a change only redoes the steps after it:

- Moving the place downloads new tiles.
- Changing the number of lines retraces them, which takes about a second.
- Changing a colour only repaints, so it is instant.

The page's only network traffic is terrain tiles, place searches and the map's
background tiles. It loads no scripts, styles or fonts from anywhere.

## Project layout

| Path | What it is |
|---|---|
| `index.html` | The built tool, one self-contained file. **Generated. Don't edit it by hand.** |
| `tool/tool.html` | The page template the build starts from. |
| `tool/tool.js` | The page's logic: settings, controls, the render pipeline, downloads, T-shirt mockup, premade designs. |
| `tool/tool-render.js` | Draws traced lines or a height grid onto a canvas. |
| `tool/tool-palettes.js` | Extra palettes, and the builder for custom colours. |
| `tool/tool-presets.js` | Reads, checks and writes premade design files. |
| `tool/tool.css` | Styling. |
| `src/elevation.js` | Terrain tile maths, fetching and decoding. |
| `src/contour.js` | Marching squares: heights into contour lines. |
| `src/ascii.js` | Heights into character cells. |
| `src/water.js` | The water surface. |
| `src/textpath.js` | Setting words along a contour line. |
| `src/palettes.js` | The core palettes and colour helpers. |
| `src/search.js` | Place search, throttled and cached as Nominatim's usage policy asks. |
| `src/map.js` | The Leaflet map for picking the centre. |
| `presets/` | Premade designs, one JSON file each. |
| `assets/` | Shirt photos, the logo and the label font. |
| `vendor/` | Leaflet and the Source Code Pro font, with their licences. |
| `scripts/build-tool.js` | Builds `index.html`. |

## Building

Because `index.html` is generated, you make changes in `tool/`, `src/`,
`presets/` or `assets/`, then rebuild. You need Node.js, but there are no
packages to install.

```
node scripts/build-tool.js           # write index.html
node scripts/build-tool.js --check   # fail if index.html is out of date
```

The build takes `tool/tool.html` and replaces each tagged script, stylesheet
and image with the contents of the file it names. Images and fonts go in as
data URIs. It then adds the premade designs from `presets/` and writes the
result to `index.html`.

To see your change, open `index.html` in a browser. Commit the rebuilt
`index.html` together with the source files you changed.

## Premade designs

Each JSON file in [`presets/`](presets/) is a card in the tool's
**Premade designs** panel. To add one:

1. Set up the design in the tool.
2. Open **Make a preset from these settings** and press **Save preset file**.
3. Move the downloaded file into `presets/`.
4. Rebuild.

A design can include its place, or leave the place out so it works as a style
on any mountain. [`presets/README.md`](presets/README.md) covers the file
format and the rules for hand-edited files.

## Scripting

The page exposes its settings and actions as `window.TopoTool`, for the browser
console or automated tests:

```js
TopoTool.state                                  // every setting
TopoTool.setPlace(45.9763, 7.6586, 'Matterhorn')
TopoTool.setDesign({ design: 'water', levels: 24 })
TopoTool.pickPreset('02-matterhorn-blueprint')
TopoTool.download()                             // save the PNG
```

Each call that changes the picture returns a promise that resolves once the
picture has been redrawn.

## Deployment

Every push to `main` publishes the repository to GitHub Pages
([`.github/workflows/static.yml`](.github/workflows/static.yml)). The site
serves the committed `index.html` as it is, with no build step. If you push
source changes without rebuilding, the site keeps showing the old version.

## Data and credits

- **Elevation:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  public dataset, credited in the page footer.
- **Place search and map tiles:** © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, search via Nominatim.
- **Map:** [Leaflet](https://leafletjs.com/), MIT licence.
- **Fonts:** Source Code Pro and Space Mono, SIL Open Font License.

The build copies every licence into the head of `index.html`, so they travel
with the file.
