import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PiFilmStrip, PiPauseFill, PiPlayFill, PiSkipBack, PiSkipForward, PiUploadSimple, PiSparkle } from "react-icons/pi";
import { applyOp, projectDuration } from "../engine/ops";
import { ASPECTS } from "../engine/types";
import { importFiles } from "../store/actions";
import { commit, useStore } from "../store/store";
import { timecode } from "./format";
import { player, seek, togglePlay } from "./playback";
import { toast } from "./toast";

async function loadSample() {
  try {
    const r = await fetch("/sample.webm");
    if (!r.ok) throw new Error();
    const blob = await r.blob();
    await importFiles([new File([blob], "sample-clip.webm", { type: "video/webm" })]);
  } catch {
    toast("Couldn't load the sample clip", "error");
  }
}

export function Preview({ onPick }: { onPick: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const project = useStore((s) => s.project);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dur = projectDuration(project);
  const { w, h } = ASPECTS[project.aspect];
  const hasClips = project.tracks.some((t) => t.clips.length);

  useEffect(() => {
    player.attach(canvasRef.current);
    return () => player.attach(null);
  }, [hasClips]);

  // Reframing jumps the frame's size; a short blur-in masks the swap so it reads as one change.
  const frameRef = useRef<HTMLDivElement>(null);
  const firstAspect = useRef(project.aspect);
  useEffect(() => {
    if (firstAspect.current === project.aspect) return;
    firstAspect.current = project.aspect;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    frameRef.current?.animate(
      [
        { filter: "blur(6px)", opacity: 0.4, transform: "scale(0.985)" },
        { filter: "blur(0px)", opacity: 1, transform: "scale(1)" },
      ],
      { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
    );
  }, [project.aspect]);

  // Fit the frame inside the viewport while keeping the project's aspect ratio.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => {
      const pad = 40;
      const bw = el.clientWidth - pad;
      const bh = el.clientHeight - pad;
      const scale = Math.min(bw / w, bh / h);
      setSize({ w: Math.max(0, Math.floor(w * scale)), h: Math.max(0, Math.floor(h * scale)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);

  return (
    <section className="stage" aria-label="Preview">
      <div className="viewport" ref={boxRef}>
        {hasClips ? (
          <div className="frame" ref={frameRef} style={{ width: size.w, height: size.h }} onClick={togglePlay}>
            <canvas ref={canvasRef} aria-label="Video preview" />
          </div>
        ) : (
          <div className="empty">
            <div className="empty-art">
              <PiFilmStrip size={28} />
            </div>
            <h1>Drop in footage, then tell it what you want</h1>
            <p>
              Clevatess edits on a real timeline. Every change the assistant makes is a clip you can drag, trim or undo.
              Files stay in your browser.
            </p>
            <div className="row">
              <button className="btn btn-primary" onClick={onPick}>
                <PiUploadSimple size={15} /> Choose files
              </button>
              <button className="btn" onClick={loadSample}>
                <PiSparkle size={15} /> Try a sample
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="transport">
        <button className="btn btn-ghost btn-icon" aria-label="Back to start" onClick={() => seek(0)} disabled={!dur}>
          <PiSkipBack size={15} />
        </button>
        <button className="btn play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} disabled={!dur}>
          {playing ? <PiPauseFill size={15} /> : <PiPlayFill size={15} style={{ marginLeft: 1 }} />}
        </button>
        <button className="btn btn-ghost btn-icon" aria-label="Skip to end" onClick={() => seek(dur)} disabled={!dur}>
          <PiSkipForward size={15} />
        </button>
        <span className="timecode tabular">
          <b>{timecode(playhead, project.fps)}</b> / {timecode(dur, project.fps)}
        </span>
        <span style={{ flex: 1 }} />
        <AspectSwitch />
      </div>
    </section>
  );
}

function AspectSwitch() {
  const aspect = useStore((s) => s.project.aspect);
  const project = useStore((s) => s.project);
  return (
    <div className="seg" role="group" aria-label="Aspect ratio">
      {(["16:9", "9:16", "1:1", "4:5"] as const).map((a) => (
        <button
          key={a}
          aria-pressed={aspect === a}
          title={ASPECTS[a].label}
          onClick={() => {
            if (a !== aspect) commit(applyOp(project, { op: "setAspect", aspect: a }));
          }}
        >
          {a}
        </button>
      ))}
    </div>
  );
}
