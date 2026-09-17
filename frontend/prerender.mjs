/**
 * Pre-render every public route to a real HTML file.
 *
 * The site is served by nginx from a plain directory, so a deep link like
 * /fcpicker/board/MatekH743 has to resolve to a file on disk — an SPA shell
 * plus client-side routing would 404 without an nginx rewrite. Each page is
 * rendered with its real content, which also fixes the sitemap advertising
 * hundreds of URLs that previously served an empty <div id="root">.
 *
 * Runs after `vite build`, against the built dist/index.html so the emitted
 * pages carry the hashed asset URLs.
 *
 *   BASE_PATH=/fcpicker/ npm run build   # build + prerender
 */
import { createServer } from "vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");
const PUBLIC = path.join(HERE, "public");

const readJson = async (f) => JSON.parse(await readFile(path.join(PUBLIC, f), "utf8"));

async function main() {
  const template = await readFile(path.join(DIST, "index.html"), "utf8");
  if (!template.includes('<div id="root"></div>')) {
    throw new Error("dist/index.html has no empty root div — did vite build run?");
  }

  const [boardsPayload, rfPayload, mfrPayload, imagesPayload] = await Promise.all([
    readJson("boards.json"),
    readJson("rangefinders.json"),
    readJson("manufacturers.json"),
    readJson("hwdef-images.json").catch(() => null),
  ]);
  const data = {
    boards: boardsPayload.boards,
    rangefinders: rfPayload.rangefinders,
    manufacturers: mfrPayload.manufacturers,
    ...(imagesPayload ? { images: imagesPayload } : {}),
  };

  // Route list mirrors routes-config.tsx. /admin is dev-only (its API lives in
  // the vite dev server) so it is deliberately not emitted.
  //
  // Rangefinders are excluded: the published site is the flight-controller
  // picker, and nothing in the header nav links to that catalog. The routes
  // still exist in the app, so they work under `npm run dev`; they are simply
  // not emitted as files, and write_sitemap() in tools/bundle.py leaves them
  // out to match. Set INCLUDE_RANGEFINDERS=1 to build them.
  const includeRangefinders = process.env.INCLUDE_RANGEFINDERS === "1";
  const paths = [
    "/",
    ...data.boards.map((b) => `/board/${b.slug}`),
    ...(includeRangefinders
      ? ["/rangefinders", ...data.rangefinders.map((r) => `/rangefinder/${r.kind}-${r.slug}`)]
      : []),
  ];

  const vite = await createServer({
    root: HERE,
    logLevel: "warn",
    server: { middlewareMode: true },
    appType: "custom",
  });

  let written = 0;
  const failures = [];
  try {
    const { render } = await vite.ssrLoadModule("/src/entry-server.tsx");
    for (const p of paths) {
      let html;
      try {
        html = await render(p, data);
      } catch (err) {
        failures.push(`${p}: ${err.message}`);
        continue;
      }
      const page = template.replace('<div id="root"></div>', `<div id="root">${html}</div>`);
      // "/" -> dist/index.html; "/board/x" -> dist/board/x/index.html, so
      // stock nginx serves it with no rewrite rule and no .html in the URL.
      const outFile =
        p === "/" ? path.join(DIST, "index.html") : path.join(DIST, p, "index.html");
      await mkdir(path.dirname(outFile), { recursive: true });
      await writeFile(outFile, page);
      written += 1;
    }
  } finally {
    await vite.close();
  }

  if (failures.length) {
    console.error(`\nprerender: ${failures.length} route(s) failed:`);
    for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`prerender: wrote ${written} HTML files to dist/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
