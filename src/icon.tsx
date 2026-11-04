// The OpenCode mark for the agent type: Buzz shows a type's icon in the New
// agent dialog's Harness menu and on library cards, and falls back to a robot
// for a type without one. Built with buzz-app's own `defineIcon`, as its
// harness marks are (src/shared/design-system/icons), so it takes the same
// size and decorative defaults.
import { forwardRef } from "react";
import {
  defineIcon,
  type IconProps,
} from "@buzz/shared/design-system/icons/createDecorativeIcon";

/** The favicon's square drawing area, in its own units. */
const TILE_SIZE = 512;
const VIEW_BOX = `0 0 ${TILE_SIZE} ${TILE_SIZE}`;
/** 15% of the tile, as on the tiled harness mark in Buzz (HarnessLogos.tsx). */
const TILE_RADIUS = 77;
/** The mark's tile and strokes, from OpenCode's favicon. */
const TILE = "#131010";
const FRAME = "#ffffff";
const CORE = "#5A5858";

/** OpenCode's favicon (packages/app/public/favicon-v3.svg in
 * anomalyco/opencode, MIT; see NOTICE). Only the tile corners are rounded,
 * so the mark sits in Buzz's rounded type menus as its own marks do. */
const OpenCodeLogoArtwork = forwardRef<SVGSVGElement, IconProps>(
  function OpenCodeLogoArtwork({ size = "1em", ...props }, ref) {
    return (
      // biome-ignore lint/a11y/noSvgWithoutTitle: Buzz supplies accessibility semantics, as for its own marks.
      <svg
        ref={ref}
        width={size}
        height={size}
        viewBox={VIEW_BOX}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <rect
          width={TILE_SIZE}
          height={TILE_SIZE}
          rx={TILE_RADIUS}
          fill={TILE}
        />
        <path d="M320 224V352H192V224H320Z" fill={CORE} />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
          fill={FRAME}
        />
      </svg>
    );
  },
);

export const OpenCodeIcon = defineIcon("custom", OpenCodeLogoArtwork, {
  meaning: "OpenCode harness",
  category: "Custom brand mark",
  provenance: "OpenCode favicon (MIT, anomalyco/opencode); see NOTICE",
  intendedSizes: [{ width: 32, height: 32 }],
});
