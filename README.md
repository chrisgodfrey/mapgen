---
title: MapGen
description: AI-assisted battlemaps for Foundry VTT.
---

**AI-assisted battlemaps for Foundry VTT.**

Turn a finished battlemap image into a playable Foundry scene, with optional
walls, doors, windows and lighting.

## Install

Requires **Foundry VTT v14**. In **Install Module**, use:

```text
https://raw.githubusercontent.com/chrisgodfrey/mapgen/main/module.json
```

Enable **MapGen** in your world, then open it from the Scenes directory.

## Create a scene

1. Describe your location and select **Copy battlemap prompt**. Use it with your
   preferred image-capable AI to create a finished PNG.
2. Optionally use **Copy metadata follow-up** in the same conversation to get
   a `scene.json` file describing the image.
3. Import the PNG and optional JSON into MapGen.
4. Preview the result, adjust the grid or lighting if needed, and select
   **Create and open in Foundry**.

An image alone works. Metadata adds native geometry and lights. The original
artwork stays unchanged, and minor metadata issues do not block import.

The lighting preview is approximate; Foundry renders final visibility and effects.

[Metadata format and supported settings](docs/scene-format.md)
