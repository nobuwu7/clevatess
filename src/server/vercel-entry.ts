// Single Vercel function serving every /api/* route (Build Output API, Node runtime).

import type { IncomingMessage, ServerResponse } from "node:http";
import { routes } from "./handlers";
import { sendWebResponse, toWebRequest } from "./node-adapter";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const request = await toWebRequest(req);
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const route = routes[path];
    const response = route
      ? await route(request, process.env)
      : new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    await sendWebResponse(res, response);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: (e as Error).message || "Server error" }));
  }
}
