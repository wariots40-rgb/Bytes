const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const apiUrl = String(process.env.BYTES_API_URL || "").trim().replace(/\\/+$/, "");

if (!apiUrl) {
  console.error("Missing BYTES_API_URL. Set it in Netlify to your Railway API base URL, e.g. https://your-service.up.railway.app");
  process.exit(1);
}
let parsed;
try { parsed = new URL(apiUrl); } catch {
  console.error("BYTES_API_URL must be a valid absolute URL.");
  process.exit(1);
}
if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
  console.error("BYTES_API_URL must use HTTPS in production.");
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const marker = "<!-- BYTES_RUNTIME_CONFIG -->";
if (!html.includes(marker)) throw new Error("Could not find the runtime-config insertion marker in index.html.");
html = html.replace(marker, '<script src="/runtime-config.js"></script>');
fs.writeFileSync(path.join(dist, "index.html"), html);
const runtime = {
  API_BASE_URL: apiUrl,
  SUPABASE_URL: String(process.env.SUPABASE_URL || "").trim(),
  SUPABASE_ANON_KEY: String(process.env.SUPABASE_ANON_KEY || "").trim()
};
fs.writeFileSync(path.join(dist, "runtime-config.js"), "window.BYTES_CONFIG = Object.freeze(" + JSON.stringify(runtime) + ");\n");
console.log("Built Bytes frontend into dist/ (Railway API URL configured; Supabase public config " + (runtime.SUPABASE_URL && runtime.SUPABASE_ANON_KEY ? "present" : "not set yet") + ").");
