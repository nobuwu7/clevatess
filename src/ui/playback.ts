// One shared preview player for the whole UI.

import { Player } from "../engine/player";
import { getBlob } from "../lib/db";
import { getState, setState, subscribe } from "../store/store";

export const player = new Player({
  onTime: (t) => setState({ playhead: t }),
  onEnded: () => setState({ playing: false }),
});

export function togglePlay() {
  if (!player.duration) return;
  player.toggle();
  setState({ playing: player.playing });
}

export function seek(t: number) {
  player.seek(t);
}

// Keep the player in step with the project as it changes.
let lastProject = getState().project;
player.setProject(lastProject);
subscribe(() => {
  const { project } = getState();
  if (project === lastProject) return;
  lastProject = project;
  player.ensureAssets(project.assets, getBlob).then(() => player.setProject(getState().project));
  player.setProject(project);
});

export async function bootPlayer() {
  const { project } = getState();
  await player.ensureAssets(project.assets, getBlob);
  player.setProject(project);
}
