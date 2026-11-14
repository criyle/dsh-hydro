/**
 * Left-sidebar entry for the Hydro panel.
 *
 * `sidebar.panellist` renders this component in the shell's panel list; the
 * registration id (`hydro`) is the same key the panel registers into the
 * keyed `main` slot, so clicking it selects the panel. The owner supplies the
 * requested edge length and whether the panel is currently selected.
 */

/** The owner props the shell passes to a `sidebar.panellist` icon. */
export interface HydroIconProps {
  /** Requested square edge in pixels. */
  size?: number
  /** Whether the Hydro panel is the selected main panel. */
  active?: boolean
}

/**
 * Render the Hydro glyph.
 * @param props - requested size and selection state.
 * @returns the icon element.
 */
export function HydroIcon({ size = 16 }: HydroIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 5.5c0-1.4 2.7-2.5 6-2.5s6 1.1 6 2.5-2.7 2.5-6 2.5-6-1.1-6-2.5Z" />
      <path d="M2 5.5v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5" />
      <path d="M2 8c0 1.4 2.7 2.5 6 2.5S14 9.4 14 8" />
    </svg>
  )
}
