// Builds the app into Vercel's Build Output API layout (.vercel/output), which is
// also what the local server serves. One command, same result locally and on Vercel.

import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel/output");
const staticDir = join(out, "static");
const watch = process.argv.includes("--watch");
const dev = watch || process.argv.includes("--dev");

async function buildClient() {
  const opts = {
    entryPoints: [join(root, "src/main.tsx")],
    bundle: true,
    outdir: join(staticDir, "assets"),
    entryNames: dev ? "[name]" : "[name]-[hash]",
    format: "esm",
    target: ["chrome111", "safari16.4", "firefox115"],
    jsx: "automatic",
    minify: !dev,
    sourcemap: dev ? "inline" : false,
    metafile: true,
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    loader: { ".css": "css" },
    logLevel: "warning",
  };
  if (watch) {
    const ctx = await context({ ...opts, plugins: [{ name: "html", setup: (b) => b.onEnd((r) => r.metafile && writeHtml(r.metafile)) }] });
    await ctx.watch();
    console.log("watching src/ …");
    return;
  }
  const result = await build(opts);
  await writeHtml(result.metafile);
}

async function writeHtml(metafile) {
  const outputs = Object.keys(metafile.outputs).map((p) => p.split("static/")[1]);
  const js = outputs.find((p) => /main(-\w+)?\.js$/.test(p));
  const css = outputs.find((p) => /main(-\w+)?\.css$/.test(p));
  let html = await readFile(join(root, "src/index.html"), "utf8");
  html = html.replace("/assets/main.js", `/${js}`).replace("/assets/main.css", `/${css}`);
  await writeFile(join(staticDir, "index.html"), html);
}

async function buildFunctions() {
  const bundle = join(out, "api-bundle.mjs");
  await build({
    entryPoints: [join(root, "src/server/vercel-entry.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: bundle,
    minify: false,
    logLevel: "warning",
  });
  const code = await readFile(bundle);
  for (const name of ["config", "chat", "transcribe"]) {
    const dir = join(out, "functions/api", `${name}.func`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.mjs"), code);
    await writeFile(
      join(dir, ".vc-config.json"),
      JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: name === "config" ? 10 : 60 }, null, 2),
    );
  }
  await rm(bundle);
}

await rm(out, { recursive: true, force: true });
await mkdir(staticDir, { recursive: true });
for (const f of await readdir(join(root, "public"))) await cp(join(root, "public", f), join(staticDir, f), { recursive: true });
await buildFunctions();
await writeFile(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/assets/(.*)$", headers: { "Cache-Control": "public, max-age=31536000, immutable" }, continue: true },
        { handle: "filesystem" },
        { src: "^/api/(.*)$", status: 404, dest: "/404" },
        { src: "^/(.*)$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
await buildClient();
if (!watch) console.log("built → .vercel/output");
