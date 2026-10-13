import { clipEnd, uid } from "./ops";
import type { Asset, MediaClip, Project, Track } from "./types";

export function newProject(name = "Untitled cut"): Project {
  return {
    id: uid("p"),
    name,
    aspect: "16:9",
    fps: 30,
    tracks: [
      { id: uid("t"), kind: "text", name: "Text", clips: [] },
      { id: uid("t"), kind: "video", name: "Video", clips: [] },
      { id: uid("t"), kind: "audio", name: "Audio", clips: [] },
    ],
    assets: [],
    transcripts: [],
    captions: { enabled: false, preset: "bold-pop", position: "bottom", maxWords: 4 },
    brand: {
      name: "My brand",
      primary: "#FFB224",
      accent: "#FF5D3A",
      text: "#FFFFFF",
      font: "Bricolage Grotesque",
      logoPosition: "top-right",
      logoOpacity: 0.9,
      fit: "contain-blur",
    },
    updatedAt: Date.now(),
  };
}

const STILL_SECONDS = 4;

/** Append an asset to the end of the right track. */
export function appendAsset(p: Project, asset: Asset): Project {
  const next = structuredClone(p);
  if (!next.assets.find((a) => a.id === asset.id)) next.assets.push(asset);
  const kind = asset.kind === "audio" ? "audio" : "video";
  let track: Track | undefined = next.tracks.find((t) => t.kind === kind);
  if (!track) {
    track = { id: uid("t"), kind, name: kind === "audio" ? "Audio" : "Video", clips: [] };
    next.tracks.push(track);
  }
  const start = track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const dur = asset.kind === "image" ? STILL_SECONDS : asset.duration;
  const clip: MediaClip = { id: uid(), type: "media", assetId: asset.id, start, in: 0, out: dur, volume: 1 };
  track.clips.push(clip);
  next.updatedAt = Date.now();
  return next;
}
