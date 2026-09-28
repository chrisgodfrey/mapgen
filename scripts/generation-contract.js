export const BATTLEMAP_PROMPT=`Create one finished VTT battlemap for MapGen and Foundry VTT.

Understand the user's location brief. Make a beautiful, atmospheric, richly dressed,
cohesive and contextually specific battlemap with environmental storytelling and
sensible tabletop proportions. Prioritize the place's character and visual quality.

CAMERA / PROJECTION REQUIREMENT - NON-NEGOTIABLE

Render the scene as a strict VTT battlemap / architectural plan view:
- camera exactly 90 degrees vertically downward;
- orthographic projection only;
- no perspective;
- no isometric projection;
- no oblique or bird's-eye camera angle;
- no horizon;
- no foreshortening;
- parallel architectural lines remain parallel;
- circles remain circles rather than ellipses;
- do not show the vertical faces or sides of walls, furniture, stairs, platforms,
  cages or other structures;
- walls should read as top-down wall thicknesses or footprints, not visible wall faces;
- stairs should be represented in plan view, not as receding perspective steps.

The result must look like a professional top-down Foundry VTT battlemap, not concept
art, a diorama, an isometric map or an aerial illustration.

Do not include UI, textual room labels or a baked-in gameplay grid unless explicitly
requested. Do not assemble an asset catalogue.

Concentrate only on producing the finished artwork in this step. Do not create wall
metadata, JSON, manifests, ZIP files or packaging instructions. Finish the battlemap
first. Provide the finished image as PNG, up to 60 MiB, at most 16384 pixels per side
and 40 million pixels total.

Before returning the image, check the camera geometry yourself. If any significant
vertical wall faces or perspective recession are visible, the image does not satisfy
the request.`;

export const METADATA_PROMPT=`Inspect the exact finished battlemap image you just created in this conversation.

Do not regenerate, redraw, repaint or redesign the image. Create a single scene.json
file describing the architecture actually visible in that exact final image.
Trace wall runs, doors and windows from the finished pixels. Do not return an earlier intended
floorplan: scene.json must describe the battlemap that actually exists.
Minor coordinate imperfections are acceptable. Preserve the battlemap rather than
inventing cleaner geometry. Do not change the image to match coordinates.

The finished battlemap is already visually lit: its painted shadows, highlights
and ambience provide the base appearance. Foundry adds visibility mechanics and
localized color, emphasis and animation, not replacement illumination from black.
For normally occupied, visibly readable homes, taverns, shops, laboratories,
palaces and other interiors, prefer globalLight true and low darkness (often 0).
Walls still control line of sight. Do not set globalLight false merely because
local emitters exist. Use false and stronger darkness only when restricted
visibility is intended, such as an unlit cave, crypt, stealth or horror scene.
Interpret the artwork and brief, not genre alone: a nighttime tavern or underground
palace may be well lit. Do not reproduce painted shadows, nighttime/blue coloring,
snow glare or magical ambience by adding substantial darkness a second time.

Only place lights at visible or strongly implied localized emitters: torches,
candles, sconces, lanterns, braziers or clearly focal magical sources/crystals.
Do not create lights merely because artwork is bright, glowing, snowy, icy,
reflective or magically color-tinted. Decorative floor glow and general ambience
can remain in the artwork. Prefer fewer sources, restrained radii, small bright
cores and broader dim edges; nearby emitters should not all flood the same area.
Support play rather than recreating every painted highlight.
When uncertain, under-light rather than over-light.
Keep the lighting expressive and contextual, not uniformly dim or colorless:
warm amber flicker for flames, selective cyan/blue for icy emitters, and a clearly
visible rhythmic pulse for focal magic when it suits the scene. Use color, luminosity
and animation intentionally; do not animate every source or maximize every value.

Choose grid.size from the actual visual scale of the finished battlemap you are
inspecting. Do not copy an example grid size mechanically. For ordinary D&D scenes,
one gameplay square represents 5 feet and a Medium creature occupies one square.
Estimate pixels per square using normal doors, corridor widths, beds, tables, chairs,
stairs, human-scale furniture and room proportions together.
A human-sized doorway is an approximate reference and will often be around one
5-foot square wide in battlemap artwork; do not assume every opening is exactly
5 feet. Use the whole scene context. Aim for plausible tabletop scale, not false
precision or photogrammetry. Keep distance: 5 and units: "ft" unless this scene
specifically requires another game scale. Do not compensate by changing creature
footprints or movement rules.

Use the MapGen v1 contract. Replace this example with the actual image data.
The null grid.size below is a placeholder, not a usable value: replace it with your
estimated integer pixels per gameplay square. Do not return null for grid.size.
{
  "format":"mapgen",
  "version":1,
  "name":"Your scene name",
  "image":{"width":2800,"height":2240},
  "grid":{"size":null,"distance":5,"units":"ft"},
  "walls":[{"x1":281,"y1":492,"x2":700,"y2":494}],
  "doors":[{"x1":700,"y1":494,"x2":770,"y2":494,"secret":false,"state":"closed"}],
  "windows":[{"x1":1053,"y1":560,"x2":1053,"y2":630}],
  "lights":[{"x":840,"y":700,"dim":15,"bright":3,"color":"#ffb45b","alpha":0.25,"luminosity":0.5,"animation":{"type":"torch","speed":5,"intensity":5}}],
  "darkness":0,
  "globalLight":true
}

Coordinates are image-space pixels: origin top-left, x rightwards and y downwards.
Fractional and diagonal segments are allowed. Width and height must describe the
actual supplied image. Trace visible architecture accurately in image-space pixels;
do not force walls, doors or windows onto gameplay grid lines. MapGen handles
minor structural coordinate normalization after import.
Grid size is your map-specific estimate in pixels per square (20 to 1000).
Grid distance is scene units per square (greater than zero, at most 10000, default 5).
Units default to ft and
use at most 32 characters. Light dim and bright radii are nonnegative distances in
those declared scene units, NOT cells or pixels. Keep the scene name to 200 characters.

Walls are blocking runs. Stop walls at doors and windows: do not put an additional
solid wall across an opening. Door state is closed, open or locked; secret is an
optional boolean, default false. Windows block movement but admit vision and light.
Do not add collision walls around furniture. Open passages have no blocking segment.
Walls, doors, windows and lights may be empty arrays. Use color as #RRGGBB; alpha
is color strength from 0 to 1. Optional luminosity is native light intensity from
0 to 1 (typically around 0.3 to 0.6). Optional animation uses type "torch" or "flame"
for fire, or "pulse" for rhythmic magic, with speed 0 to 10 and intensity 1 to 10.
Make selected animations clearly perceptible at normal play zoom, not nearly static.
For torch/flame start around speed 5 and intensity 5; for magical pulse start around
speed 3 to 5 and intensity 5 to 6. Avoid defaulting to 1 or 2 for both parameters.
Conservative lighting means limited coverage and brightness, not imperceptible motion.
Keep radii and luminosity restrained instead of weakening animation until it vanishes.
Do not animate every source or use frenetic/maximal flashing; omit animation when static fits.
Native speed/intensity use whole-number steps; positive fractional suggestions are
normalized on import. Speed 0 intentionally pauses animation.
Darkness ranges from 0 to 1. Choose darkness and globalLight for visibility needs,
not the number of local lights. Local effects should not be required to make an
otherwise readable room visible. Empty lights arrays are valid.

Return one scene.json file, at most 2 MiB, as the deliverable. No new artwork is
needed. If you cannot attach a file, return only the complete JSON so it can be
saved as scene.json; do not claim to have attached a file you did not create.`;

export function battlemapPrompt(brief='') {
  return brief.trim()?`${BATTLEMAP_PROMPT}\n\nUSER LOCATION BRIEF:\n${brief.trim()}`:BATTLEMAP_PROMPT;
}
