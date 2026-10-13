// Core data model for a Clevatess project.
// All times are in seconds. "Timeline time" is where something sits in the edit;
// "source time" is the position inside the original media file.

export type AssetKind = "video" | "audio" | "image";

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  duration: number; // seconds; images get a default still duration
  width?: number;
  height?: number;
  mime: string;
  size: number;
}

export type TrackKind = "video" | "text" | "audio";

export interface MediaClip {
  id: string;
  type: "media";
  assetId: string;
  start: number; // timeline time
  in: number; // source time where the clip begins
  out: number; // source time where the clip ends
  volume: number; // 0..1
}

export type TextRole = "title" | "lower-third" | "callout";

export interface TextClip {
  id: string;
  type: "text";
  start: number;
  duration: number;
  text: string;
  role: TextRole;
}

export type Clip = MediaClip | TextClip;

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  muted?: boolean;
}

export interface Word {
  text: string;
  start: number; // source time
  end: number;
}

export interface Transcript {
  assetId: string;
  words: Word[];
  language?: string;
}

export type CaptionPreset = "clean" | "bold-pop" | "karaoke" | "boxed" | "minimal" | "editorial";

export interface CaptionSettings {
  enabled: boolean;
  preset: CaptionPreset;
  position: "bottom" | "middle" | "top";
  maxWords: number; // words per caption line group
}

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5";

export interface BrandKit {
  name: string;
  primary: string; // main brand colour (caption highlight, title cards)
  accent: string;
  text: string;
  font: string; // display font family
  logoAssetId?: string;
  logoPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  logoOpacity: number;
  fit: "cover" | "contain-blur"; // how footage fills a frame of a different shape
}

export interface Project {
  id: string;
  name: string;
  aspect: AspectRatio;
  fps: number;
  tracks: Track[];
  assets: Asset[];
  transcripts: Transcript[];
  captions: CaptionSettings;
  brand: BrandKit;
  updatedAt: number;
}

export const ASPECTS: Record<AspectRatio, { w: number; h: number; label: string }> = {
  "16:9": { w: 1920, h: 1080, label: "Landscape" },
  "9:16": { w: 1080, h: 1920, label: "Vertical" },
  "1:1": { w: 1080, h: 1080, label: "Square" },
  "4:5": { w: 1080, h: 1350, label: "Portrait" },
};
