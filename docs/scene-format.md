---
title: Optional scene metadata
description: MapGen version-one scene.json contract and tolerant import rules
---

## Image first

A finished PNG is sufficient to create and play a Foundry scene. Optional
`scene.json` adds native walls, doors, windows and lights. Select or drop both
files together, or select the metadata before or after its image.

Metadata identifies itself as `"format": "mapgen", "version": 1`.

The image is never repainted, cropped, resized or re-encoded. Its actual pixels
are the visual source of truth. Metadata describes that image, not a planned
floorplan or a grid that the artwork must fit.

## Scene contract

Choose the pixel scale from the actual image, using ordinary doors, corridors,
beds, tables, chairs, stairs and room proportions together. A human-scale doorway
is a useful approximate reference, not proof that every opening is exactly 5ft.
For ordinary D&D scenes, keep 5ft per square and one-square Medium creatures.

This schema illustration is not a ready-to-use scene: replace the null `grid.size`
placeholder with the estimated integer pixels per gameplay square.

```json
{
  "format": "mapgen",
  "version": 1,
  "name": "Example scene",
  "image": { "width": 2800, "height": 2240 },
  "grid": { "size": null, "distance": 5, "units": "ft" },
  "walls": [
    { "x1": 281, "y1": 492, "x2": 700, "y2": 494 }
  ],
  "doors": [
    { "x1": 700, "y1": 494, "x2": 770, "y2": 494, "secret": false, "state": "closed" }
  ],
  "windows": [
    { "x1": 1053, "y1": 560, "x2": 1053, "y2": 630 }
  ],
  "lights": [
    {
      "x": 840, "y": 700, "dim": 15, "bright": 3,
      "color": "#ffb45b", "alpha": 0.25, "luminosity": 0.5,
      "animation": { "type": "torch", "speed": 5, "intensity": 5, "reverse": false }
    }
  ],
  "darkness": 0,
  "globalLight": true
}
```

* Coordinates are pixels in the final image: origin top-left, x right, y down.
* Fractional and diagonal segments are supported. Coordinates are not grid cells.
* `image.width` and `image.height` describe the actual supplied image.
* `grid.size` is the map-specific pixels per square, from 20 to 1000.
  Fractional estimates are rounded to native whole pixels with a note.
* `grid.distance` is scene units per square, greater than 0 and at most 10000. Default: 5.
* `grid.units` is 1 to 32 characters and defaults to `ft`.
* Light `dim` and `bright` radii use scene units, not cells or pixels.
* Door `state` is `closed`, `open` or `locked`. `secret` defaults to false.
* Windows block movement but admit vision and light.
* `darkness` and light `alpha` range from 0 to 1. Missing alpha defaults to 0.25.
* Optional `luminosity` is native light intensity from 0 to 1; omitted values use
  Foundry's default 0.5. Color alpha is color strength, not a brightness multiplier.
* Optional `animation` contains a native `type`, `speed` (0..10), `intensity`
  (1..10) and `reverse` boolean. Recommended portable types are `torch`, `flame`
  and `pulse`; the installed Foundry animation catalog determines availability.
  Omitted speed/intensity default to the native midpoint 5 / 5. Native v14 fields are integer
  steps, so suggestions such as 1.6/1.5 become 2/2 with a note. A positive speed
  below 0.5 becomes 1 rather than unintentionally pausing; explicit speed 0 pauses.
  Unavailable effects are omitted with a note, without dropping the light or map.
* Missing illumination settings independently default to `globalLight: true`
  and `darkness: 0`, with or without local emitters. Explicit settings always win.
* Empty or omitted `walls`, `doors`, `windows` and `lights` arrays are valid.
* Names are at most 200 characters; invalid names recover to a default.
* Additional optional properties are ignored, not passed through to Foundry.

Stop wall runs at openings. Exactly collinear door/window spans are removed from
underlying walls during native serialization. Detached openings receive only the
same endpoint quantization; they are not relocated onto nearby walls. Furniture needs no collision
walls. An open passage has no blocking segment.

## Tolerant import

No metadata is a normal successful import, without a warning. It uses the image
filename as the scene name when suitable, default grid settings, global illumination
and empty geometry.
The image-only starting grid is 70px/5ft, not an estimate of the artwork's scale.
It remains editable. Missing or invalid metadata uses a starting fallback; invalid
manual edits retain the previous usable calibration instead of forcing a new scale.
Large-but-allowed values relative to the image produce a secondary scale-check
note, not rejection or an automatic replacement of a legitimate estimate.

Malformed, unreadable, oversized or unsupported metadata leaves the image usable.
When replacing already loaded metadata, such a file keeps the previous usable
scene preview instead of erasing it. Notes remain collapsed and nonblocking.
The user never needs to acknowledge warnings or return to the model to continue.

Valid JSON collections retain usable records even when their neighbors are
malformed. Nonfinite coordinates, zero-length segments and records more than
8 pixels outside the image are skipped. Near-boundary coordinates are clamped.
Small gaps, overlaps, crossings, detached openings and off-grid architecture remain
usable; structural endpoints receive the fine quantization described below.
Numeric strings are recovered where safe, with a warning.

Incorrect declared dimensions produce a warning. Actual decoded dimensions win,
without rescaling the image or metadata coordinates. Missing format/version can
be treated as version one with a warning; an explicit unsupported version is not
interpreted. Invalid optional values use defaults or bounded values with warnings.
Foundry's coordinate-field cleaning may round fractional native coordinates.

Changing the image clears metadata belonging to the previous image. New metadata
replaces the current preview's geometry; omitted grid/lighting settings retain the
preview's existing settings. **Use image only** removes imported geometry while
keeping the image and chosen settings.

## Editing gameplay calibration

The grid-size, distance and units fields update the preview grid immediately,
including a readout of one square's game distance and pixel footprint.
Editing or saving calibration never moves the image or existing structural
geometry, before or after scene creation. Light positions and game-unit radii stay
unchanged. Do not compensate by changing creature footprints or movement rules.

## Conservative gameplay lighting

The finished artwork already provides base ambience, readability and painted
shadows. Global illumination supplies basic gameplay visibility while walls still
control line of sight. Ordinary inhabited/readable rooms can keep it enabled
alongside expressive local lights. Choose global illumination off and higher
darkness only when restricted visibility itself is intended, not merely because
the image contains shadows, night colors or light sources.

Only actual visible or strongly implied emitters belong in `lights`. Bright snow,
ice, reflections, decorative floor art and magical color grading do not
automatically require light documents. Prefer localized emitters, restrained
radii and small bright cores within broader dim regions. Keep sources expressive:
choose contextual color and luminosity, visible warm flame flicker or rhythmic
focal magical pulses rather than uniformly dimming away all character.
The metadata prompt recommends torch/flame around speed 5 and intensity 5,
and magical pulse around speed 3 to 5 and intensity 5 to 6. Limit spatial reach
and brightness separately; do not make intentional animation effectively invisible.
Supplied lower values remain respected, and saved native effects are not
automatically rewritten.

The importer never infers lights from artwork. It omits zero-radius records and
repeated sources with matching color, radii, intensity and effects at the same
native pixel. Different intentional effects are not merged. It does not
attempt to classify an explicitly supplied nonzero light as decoration from its
coordinates or color. Obviously invalid radii, including values above one million
scene units, recover as optional field errors rather than failing the image.

The application starts new metadata at 50% radii, adjustable through the single
**Imported light radius** control. The external JSON structure is unchanged:
`dim` and `bright` remain the model's baseline radii in scene units. Scaling does
not change emitter coordinates, image pixels or structural geometry.

Animation intent is normalized at parsing and again at native serialization
against the current registered catalog. Exact native keys take priority. A small
set of obvious aliases maps fire to flame, flicker/flickering/candle/candlelight
to torch, and pulsing/slow pulse to pulse. Other unrecognized names remain static.
The saved representation is `config.animation: {type, speed, intensity, reverse}`;
radius tuning updates only spatial reach and its baseline flags, not color,
luminosity, animation or environmental intent.

Darkness/global illumination and radius changes update an approximate tone/coverage
preview. The same effective values are used for scene creation and saving.
The preview does not reproduce Foundry wall occlusion, token vision, directional
effects or animated shaders; it is a guide to density and atmosphere, not a
pixel-identical Foundry renderer.
Native animation also depends on an active source and Foundry's per-client Animate
Light Sources setting. The importer does not change that preference. Schema and
serialization checks establish the data path, not visible shader motion.

Saved imported sources carry small internal baseline flags, and the scene records
the selected radius scale. Repeated tuning is noncumulative. Native edits to their
radii are respected on reopen; later unmarked GM-added lights are not scaled.
Scenes without stored light baselines retain their current values until explicit
tuning adopts their existing light set. These internal flags are not extra interchange files.

## Structural normalization

Trace the finished image honestly; do not pre-snap metadata. After tolerant parsing,
only wall, door and window endpoints are quantized. Lights and gameplay settings are
not part of this operation. No separate axis alignment, room inference or extra
merge tolerance is applied.

MapGen uses Foundry's public
[SquareGrid.getSnappedPoint](https://foundryvtt.com/api/v14/classes/foundry.grid.SquareGrid.html#getsnappedpoint),
with `CENTER | VERTEX | CORNER | SIDE_MIDPOINT` and API `resolution: 4`.
Together these produce eight subdivisions at every supported map scale. This is
intentionally fixed, rather than the native wall toolbar's adaptive subdivisions.

| Gameplay pixels per square | Structural spacing |
|----------------------------|--------------------|
| 40                         | 5px                |
| 45                         | 5.625px            |
| 70                         | 8.75px             |
| 160                        | 20px               |

Spacing is always `grid.size / 8`. For each axis the local equivalent is
`origin + round((coordinate - origin) / spacing) * spacing`.
Equal lattice vertices produce exactly shared endpoints. A diagonal or segmented
curve receives the same endpoint operation, not a separate reconstruction pass.
Precision follows the per-map integer grid size Foundry will store. The normalizer
does not change gameplay distance, units or creature size.

New imports explicitly use zero padding, zero scene shifts and an untransformed
background. Foundry's public `Scene.getDimensions()` confirms the image and canvas
origins coincide for that frame. The module never borrows the active scene's grid:
it uses the new scene's size. In a translated image frame, snapping is performed
in grid coordinates and then translated back; the image-space grid origin is the
negative of `sceneX`/`sceneY`. Existing shifted/padded/transformed scenes remain
unsupported for reopening rather than silently using the wrong origin.

Native Wall fields in verified v14.368 round to integer pixels. Quantization is
followed by that same cleaning before preview, so ideal 8.75/17.5/26.25px vertices
appear and persist as 9/18/26px. This rounding is normal native behavior, not a
change to the chosen gameplay calibration. Lights keep their existing separate host cleaning.

If quantization collapses a short usable segment or pushes it outside the image,
its supplied coordinates are retained at native pixel precision with a secondary
warning. Individually unusable records are skipped. No import-wide rejection occurs.
Raw parsed structural coordinates remain available in memory for diagnostics.
Normalization happens once when metadata is applied. Subsequent calibration
edits and creation preserve that prepared geometry; new metadata uses its newly
supplied scale. Reopening or saving settings never re-quantizes native edits.

## File safety and limits

| Resource                   | Limit             |
|----------------------------|-------------------|
| PNG file                   | 60 MiB            |
| JSON file                  | 2 MiB             |
| Image side                 | 16384 pixels      |
| Image area                 | 40 million pixels |
| Geometry and light records | 20000 total       |

PNG dimensions are checked before browser decoding and verified afterwards.
JSON is read as data, never executable code. These limits protect the browser,
not geometric perfection. Version one currently accepts PNG artwork only.

## Generating the two files

The [canonical prompts](../scripts/generation-contract.js) are also available in
the application. Turn 1 produces only the completed artwork. Turn 2 inspects that
exact image in the same conversation and returns `scene.json`, without generating
another image. A higher reasoning mode may help the second turn if available;
it is optional and does not depend on a subscription tier.
