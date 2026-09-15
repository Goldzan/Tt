# Premade designs

Every `.json` file in this folder becomes a card under **Premade designs** in the
tool. Picking a card sets every setting on the page to the design's. Cards are
listed in file-name order, so number the files (`01-…`, `02-…`) to set the order.

## Making one

1. Open the tool (`index.html`) and set up the design you want.
2. Open **Make a preset from these settings** under *Premade designs*, type a
   name, and press **Save preset file**.
   - Untick **Include the place** for a style that goes on whatever mountain is
     already on the map, rather than on this one.
3. Move the downloaded file into this folder.
4. Rebuild the page, then commit the new file along with `index.html`:

   ```
   node scripts/build-tool.js
   ```

**Try a preset file…** loads a file straight from disk without rebuilding, so
you can check it first. A file with the same name as one already in the list
takes its place until the page is reloaded.

To change an existing design, pick it, change what you want, and save it again
under the same file name.

## What is in a file

```json
{
  "name": "Matterhorn blueprint",
  "description": "Shown when you hover over the card.",
  "settings": {
    "design": "contours",
    "preset": "blueprint",
    "levels": 32,
    "...": "..."
  }
}
```

`settings` uses the tool's own setting names, the same ones as
`TopoTool.state` in the browser console. Saved files include every setting.
You can also edit a file by hand or write a short one yourself:

- A setting the file leaves out goes back to the page's default when the
  design is picked.
- The exception is the place settings (`lat`, `lng`, `place`, `widthM`,
  `captionName`). If the file leaves those out, the map stays on the current
  place.
- Colours are `"#rrggbb"`. `borderInk` and `captionInk` can be `null` to follow
  the map's own colours.
- `view`, `scale` and `filename` are not part of a design. The tool never saves
  them, and skips them if a file includes them.

If a setting is misspelled, or has the wrong type of value, the tool skips it
and lists it under the cards when the design is picked. The rest of the file
still applies. If a file isn't valid JSON, or has no `name` or `settings`, the
build fails and tells you which file it is.
