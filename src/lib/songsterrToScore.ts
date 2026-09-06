/**
 * Songsterr native note model -> AlphaTab `Score` converter.
 *
 * Maps a single {@link SongsterrTrack} into a renderable
 * `@coderline/alphatab` (v1.8.x) `model.Score`.
 *
 * The mapping logic (string-index convention, duration matching, tuning, ties)
 * follows the reference converter:
 *   Metaphysics0/songsterr-downloader
 *   src/lib/server/services/converter/songsterr-to-alphatab.converter.ts
 *   src/lib/server/services/converter/duration-mapper.ts
 * (read from raw.githubusercontent.com, main branch).
 *
 * Key conventions verified against that reference + the installed alphaTab types:
 *  - Songsterr string 0 = HIGHEST-pitched string; alphaTab string 1 = LOWEST.
 *    => alphaTab.string = numStrings - songsterrString.
 *  - alphaTab `Duration` enum values ARE the note denominators
 *    (Whole=1, Half=2, Quarter=4, Eighth=8, Sixteenth=16, ThirtySecond=32,
 *     SixtyFourth=64). So a Songsterr [num,den] duration is matched by finding
 *    the closest base-duration + dots combination (handles 3=dotted, 7=double-dotted,
 *    and any odd ratios robustly), exactly like the reference's mapSongsterrDuration.
 *  - Custom tuning is passed verbatim to `new model.Tuning('Custom', tuning, false)`;
 *    Songsterr `tuning` is MIDI high->low, which is the order alphaTab's Tuning wants.
 */

import * as alphaTab from "@coderline/alphatab";
import type { SongsterrTrack, SongsterrBeat } from "./types";
import { notatedDuration } from "./tabDuration";

/** Notated denominator → alphaTab Duration (the enum values ARE the denominators). */
const DURATION_BY_DENOMINATOR: Record<number, alphaTab.model.Duration> = {
  1: alphaTab.model.Duration.Whole,
  2: alphaTab.model.Duration.Half,
  4: alphaTab.model.Duration.Quarter,
  8: alphaTab.model.Duration.Eighth,
  16: alphaTab.model.Duration.Sixteenth,
  32: alphaTab.model.Duration.ThirtySecond,
  64: alphaTab.model.Duration.SixtyFourth,
};

/**
 * Apply a Songsterr beat's timing to an alphaTab beat: notated value, dots and
 * tuplet (n:m). Songsterr's `duration` is the REAL fraction with the tuplet
 * baked in — the old mapper rounded a quarter triplet (1/6) to a dotted eighth,
 * so every triplet bar overflowed and the cursor drifted off the notes.
 */
function applyDuration(beat: alphaTab.model.Beat, beatData: SongsterrBeat) {
  const nd = notatedDuration(beatData.duration, beatData.dots, beatData.tuplet, beatData.type);
  beat.duration = DURATION_BY_DENOMINATOR[nd.denominator] ?? alphaTab.model.Duration.Quarter;
  beat.dots = nd.dots;
  if (nd.tupletNumerator > 1) {
    beat.tupletNumerator = nd.tupletNumerator;
    beat.tupletDenominator = nd.tupletDenominator;
  }
}

/** A whole rest, used for empty/missing voices. */
function makeWholeRest(): alphaTab.model.Beat {
  const beat = new alphaTab.model.Beat();
  beat.isEmpty = true; // empty beat renders as a rest sized to the bar
  beat.duration = alphaTab.model.Duration.Whole;
  beat.dots = 0;
  return beat;
}

/** Build an alphaTab Beat from a Songsterr beat. Never throws. */
function mapBeat(
  beatData: SongsterrBeat,
  numStrings: number,
  drumIndex: Map<number, number> | null,
): alphaTab.model.Beat {
  const beat = new alphaTab.model.Beat();
  applyDuration(beat, beatData);

  // Carry the chord symbol text (e.g. "F5") onto the beat as display text.
  const chordText = beatData.chord?.text;
  if (typeof chordText === "string" && chordText.length > 0) {
    beat.text = chordText;
  }

  const notes = Array.isArray(beatData.notes) ? beatData.notes : [];

  // Explicit rest, or a beat with no playable notes -> empty (rest) beat.
  if (beatData.rest === true || notes.length === 0) {
    beat.isEmpty = true;
    return beat;
  }

  for (const noteData of notes) {
    if (!noteData) continue;
    // Drums skip non-finite frets (a rest/blip) exactly like the articulation scan,
    // so the percussionArticulation index always resolves to the right instrument.
    if (drumIndex && !Number.isFinite(noteData.fret)) continue;
    const songsterrString = Number.isFinite(noteData.string) ? noteData.string : 0;
    const fret = Number.isFinite(noteData.fret) ? noteData.fret : 0;

    const note = new alphaTab.model.Note();
    if (drumIndex) {
      // Drums: fret carries the GM-percussion MIDI; map to its articulation index.
      note.percussionArticulation = drumIndex.get(fret) ?? 0;
    } else {
      // Songsterr string 0 = highest pitch; alphaTab string 1 = lowest pitch.
      // Clamp into the valid [1, numStrings] range so a bad index never breaks finish().
      const mappedString = numStrings - songsterrString;
      note.string = Math.min(numStrings, Math.max(1, mappedString));
      note.fret = Math.max(0, Math.min(fret, 99));
    }

    if (noteData.dead) note.isDead = true;
    if (noteData.ghost) note.isGhost = true;
    if (noteData.tie) note.isTieDestination = true;

    beat.addNote(note);
  }

  // If every note got filtered out, fall back to a rest so the bar stays valid.
  if (beat.notes.length === 0) {
    beat.isEmpty = true;
  }

  return beat;
}

export type TabKind = "guitar" | "bass" | "piano" | "drums";

// GM percussion MIDI numbers that read with an X notehead (cymbals/hi-hat).
const CYMBAL_MIDIS = new Set([42, 44, 46, 49, 51, 52, 53, 55, 57, 59]);
const NOTEHEAD_BLACK = 57508;
const NOTEHEAD_X = 57513;

/**
 * Convert a Songsterr track into a renderable alphaTab Score.
 *
 * @param track Songsterr native track (tuning MIDI high->low, measures[].voices[].beats[]).
 * @param title Optional score title (falls back to the track name).
 * @param kind  guitar/bass (tab) · piano (notation) · drums (percussion staff).
 */
export function songsterrToScore(
  track: SongsterrTrack,
  title?: string,
  kind: TabKind = "guitar",
): alphaTab.model.Score {
  const score = new alphaTab.model.Score();
  // No title/credits header — the panel already shows the song name, and an empty
  // header keeps the horizontal single-row layout compact (no tall title block).
  void title;
  score.title = "";
  score.tab = "";
  // Tempo (BPM) drives AlphaTab's time→beat mapping so the playback cursor
  // (timePosition, ms) lines up with our audio. `score.tempo` is read-only, so
  // the tempo lives in the master bars' tempoAutomations (reference 0 = the form
  // AlphaTab uses internally). Songsterr keeps changes in automations.tempo.
  const tempoByMeasure = new Map<number, number>();
  for (const a of track?.automations?.tempo ?? []) {
    if (typeof a?.measure === "number" && typeof a?.bpm === "number" && a.bpm > 0) {
      tempoByMeasure.set(a.measure, a.bpm);
    }
  }
  const initialBpm = track?.automations?.tempo?.[0]?.bpm ?? 120;

  const measures = Array.isArray(track?.measures) ? track.measures : [];
  const masterBarCount = Math.max(1, measures.length);

  // --- Tuning / string count -------------------------------------------------
  const tuning =
    Array.isArray(track?.tuning) && track.tuning.length > 0
      ? track.tuning.filter((n) => Number.isFinite(n))
      : null;
  // Standard 6-string guitar (E2 A2 D3 G3 B3 E4) high->low as a sane default.
  const numStrings =
    tuning && tuning.length > 0
      ? tuning.length
      : typeof track?.strings === "number" && track.strings > 0
        ? track.strings
        : 6;

  // --- Master bars (running time signature) ---------------------------------
  let tsNum = 4;
  let tsDen = 4;
  for (let i = 0; i < masterBarCount; i++) {
    const sig = measures[i]?.signature;
    if (Array.isArray(sig) && sig.length === 2 && sig[0] && sig[1]) {
      tsNum = sig[0];
      tsDen = sig[1];
    }

    const masterBar = new alphaTab.model.MasterBar();
    masterBar.timeSignatureNumerator = tsNum;
    masterBar.timeSignatureDenominator = tsDen;

    // Tempo: bar 0 gets the initial BPM; later bars only on a change.
    const barBpm = i === 0 ? (tempoByMeasure.get(0) ?? initialBpm) : tempoByMeasure.get(i);
    if (typeof barBpm === "number" && barBpm > 0) {
      masterBar.tempoAutomations = [
        alphaTab.model.Automation.buildTempoAutomation(false, 0, barBpm, 0),
      ];
    }

    const markerText = measures[i]?.marker?.text;
    if (typeof markerText === "string" && markerText.length > 0) {
      const section = new alphaTab.model.Section();
      section.marker = markerText;
      section.text = markerText;
      masterBar.section = section;
    }

    score.addMasterBar(masterBar);
  }

  // --- Track / staff ---------------------------------------------------------
  const atTrack = new alphaTab.model.Track();
  atTrack.name = track?.name ?? track?.instrument ?? "Track";
  atTrack.shortName = atTrack.name.slice(0, 20);

  // Drums: build a percussion articulation table from the track's notes. Songsterr
  // encodes each drum note as fret = GM-percussion MIDI + string = staff position;
  // we map each unique MIDI to an InstrumentArticulation (staff line + note head).
  const isDrums = kind === "drums";
  const drumIndex = new Map<number, number>();
  if (isDrums) {
    const artics: alphaTab.model.InstrumentArticulation[] = [];
    for (const m of measures) {
      for (const v of m?.voices ?? []) {
        for (const b of v?.beats ?? []) {
          for (const n of b?.notes ?? []) {
            if (!n || !Number.isFinite(n.fret)) continue;
            const midi = n.fret;
            if (drumIndex.has(midi)) continue;
            const raw = Math.round((Number.isFinite(n.string) ? (n.string as number) : 1.5) * 2) + 1;
            const sLine = Math.max(-8, Math.min(16, raw)); // keep within a sane staff range
            const head = (CYMBAL_MIDIS.has(midi) ? NOTEHEAD_X : NOTEHEAD_BLACK) as unknown as alphaTab.model.MusicFontSymbol;
            drumIndex.set(midi, artics.length);
            artics.push(
              new alphaTab.model.InstrumentArticulation("drums", sLine, midi, head, head, head),
            );
          }
        }
      }
    }
    // A drum track with no real notes (all rests) → keep one default articulation
    // so `percussionArticulations` is never empty (AlphaTab indexes into it).
    if (artics.length === 0) {
      const h = NOTEHEAD_BLACK as unknown as alphaTab.model.MusicFontSymbol;
      artics.push(new alphaTab.model.InstrumentArticulation("drums", 3, 38, h, h, h));
    }
    atTrack.percussionArticulations = artics;
  }

  const staff = new alphaTab.model.Staff();
  if (tuning && tuning.length > 0 && !isDrums) {
    staff.stringTuning = new alphaTab.model.Tuning("Custom", tuning, false);
  }
  if (isDrums) {
    staff.isPercussion = true;
    staff.showStandardNotation = true;
    staff.showTablature = false;
  } else if (kind === "piano") {
    // Piano notes are correct (string/fret → MIDI); the fret-tab is meaningless,
    // so show notation only.
    staff.showStandardNotation = true;
    staff.showTablature = false;
  } else {
    staff.showTablature = true;
    staff.showStandardNotation = false;
  }

  // --- Bars -> voice -> beats ------------------------------------------------
  // alphaTab requires every bar in a staff to carry the same number of voices,
  // so pre-scan for the max voice count and pad short bars with rest voices.
  let maxVoiceCount = 1;
  for (let i = 0; i < masterBarCount; i++) {
    const v = measures[i]?.voices;
    if (Array.isArray(v)) maxVoiceCount = Math.max(maxVoiceCount, v.length);
  }

  for (let measureIndex = 0; measureIndex < masterBarCount; measureIndex++) {
    const bar = new alphaTab.model.Bar();
    const measure = measures[measureIndex];
    const voices = Array.isArray(measure?.voices) ? measure!.voices : [];

    if (voices.length === 0) {
      const voice = new alphaTab.model.Voice();
      voice.addBeat(makeWholeRest());
      bar.addVoice(voice);
    } else {
      for (const sourceVoice of voices) {
        const voice = new alphaTab.model.Voice();
        const beats = Array.isArray(sourceVoice?.beats) ? sourceVoice.beats : [];

        if (beats.length === 0) {
          voice.addBeat(makeWholeRest());
        } else {
          for (const beatData of beats) {
            if (!beatData) continue;
            try {
              voice.addBeat(mapBeat(beatData, numStrings, isDrums ? drumIndex : null));
            } catch {
              // Defensive: a single malformed beat must not kill the track.
              voice.addBeat(makeWholeRest());
            }
          }
          if (voice.beats.length === 0) voice.addBeat(makeWholeRest());
        }
        bar.addVoice(voice);
      }
    }

    // Pad to the staff-wide voice count with rest voices.
    for (let v = bar.voices.length; v < maxVoiceCount; v++) {
      const restVoice = new alphaTab.model.Voice();
      restVoice.addBeat(makeWholeRest());
      bar.addVoice(restVoice);
    }

    staff.addBar(bar);
  }

  atTrack.addStaff(staff);
  score.addTrack(atTrack);

  // Wire up parent/index references; required before rendering.
  const settings = new alphaTab.Settings();
  score.finish(settings);

  return score;
}
