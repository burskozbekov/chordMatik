/**
 * chordMatik design tokens (TypeScript mirror of the CSS palette).
 *
 * Use these where colors must be driven from JS — e.g. the animated
 * timeline, canvas/SVG visuals, or Motion style values. Keep this file
 * in sync with `src/styles/globals.css`.
 */

// Light-green palette — keys kept (sky/mint/teal), values are fresh greens.
export const brand = {
  sky: "#16CF86", // primary — vivid emerald
  skyStrong: "#08A86B", // deep emerald
  skySoft: "#A7F3D0", // light green
  mint: "#34D399", // secondary — emerald
  mintSoft: "#BBF7D0", // very light green
  teal: "#5EEAD4", // bridge — light teal
} as const;

export const text = {
  primary: "#123528", // deep forest green
  secondary: "#2F5D45", // pine
  muted: "#5E806E", // sage
} as const;

/** The signature active-chord gradient (vivid emerald). */
export const CHORD_ACTIVE_GRADIENT = `linear-gradient(135deg, #08A86B 0%, #14C97E 48%, ${brand.mint} 100%)`;

/** Supported audio formats (single source of truth for pickers + copy). */
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "flac", "ogg"] as const;
export type AudioExtension = (typeof AUDIO_EXTENSIONS)[number];

/** Motion easing curves used across synced UI (mirrors HeroUI's fluid curve). */
export const easing = {
  fluid: [0.32, 0.72, 0, 1] as const,
  outExpo: [0.19, 1, 0.22, 1] as const,
} as const;
