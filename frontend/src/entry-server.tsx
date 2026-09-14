import { renderToString } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from "react-router";
import { routes } from "./routes-config";
import { primeCaches } from "./data";
import type { Board, Manufacturer, Rangefinder } from "./types";

export interface PrerenderData {
  boards: Board[];
  rangefinders: Rangefinder[];
  manufacturers: Manufacturer[];
  images?: {
    base_url: string;
    boards: { slug: string; is_autopilot: boolean; images: string[] }[];
  };
}

// Render one route to HTML. `path` is app-relative ("/board/MatekH743"); the
// base prefix is applied by the router, so the emitted markup carries links
// that already match wherever the site is served from.
export async function render(path: string, data: PrerenderData): Promise<string> {
  primeCaches(data);

  const basename = import.meta.env.BASE_URL;
  const handler = createStaticHandler(routes, { basename });
  // The handler matches against the full served path, so the request URL has
  // to carry the base prefix that the handler will then strip.
  const prefix = basename.replace(/\/$/, "");
  const url = new URL(`${prefix}${path}`, "http://localhost");
  const context = await handler.query(new Request(url, { method: "GET" }));

  if (context instanceof Response) {
    throw new Error(`route ${path} produced a ${context.status} response`);
  }

  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(
    <StaticRouterProvider router={router} context={context} nonce={undefined} />,
  );
}
