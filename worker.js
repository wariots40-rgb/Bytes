import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import app from "./server.js";

// Keep the existing Express API and route behavior; Cloudflare adapts its HTTP
// server to the Workers request lifecycle. No app.listen() or fixed port needed.
const server = createServer(app);

export default httpServerHandler(server);
