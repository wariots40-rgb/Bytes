const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const pubDir = path.join(root, "public");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

if (fs.existsSync(pubDir)) {
  fs.cpSync(pubDir, dist, { recursive: true });
}

let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const marker = "<!-- BYTES_RUNTIME_CONFIG -->";
if (html.includes(marker)) {
  html = html.replace(marker, '<script src="/runtime-config.js"></script>');
}
fs.writeFileSync(path.join(dist, "index.html"), html);

const runtime = {
  API_BASE_URL: "",
  SUPABASE_URL: String(process.env.SUPABASE_URL || "https://twslcchmbakezfynbafc.supabase.co").trim(),
  SUPABASE_ANON_KEY: String(process.env.SUPABASE_ANON_KEY || "").trim(),
  CLERK_PUBLISHABLE_KEY: String(process.env.CLERK_PUBLISHABLE_KEY || "pk_test_Y29tcGxldGUtYWFyZHZhcmstMjc1My5jbGVyay5hY2NvdW50cy5kZXYk").trim()
};
fs.writeFileSync(
  path.join(dist, "runtime-config.js"),
  "window.BYTES_CONFIG = Object.freeze(" + JSON.stringify(runtime) + ");\n"
);

// Generate embedded assets for standalone Worker fallback
const faviconSvg = fs.existsSync(path.join(pubDir, "favicon.svg"))
  ? fs.readFileSync(path.join(pubDir, "favicon.svg"), "utf8")
  : "";
const logoSvg = fs.existsSync(path.join(pubDir, "logo.svg"))
  ? fs.readFileSync(path.join(pubDir, "logo.svg"), "utf8")
  : "";
const logoMarkSvg = fs.existsSync(path.join(pubDir, "logo-mark.svg"))
  ? fs.readFileSync(path.join(pubDir, "logo-mark.svg"), "utf8")
  : "";

const embeddedCode = `// Generated embedded assets for Cloudflare Worker standalone serving
export const INDEX_HTML = ${JSON.stringify(html)};
export const FAVICON_SVG = ${JSON.stringify(faviconSvg)};
export const LOGO_SVG = ${JSON.stringify(logoSvg)};
export const LOGO_MARK_SVG = ${JSON.stringify(logoMarkSvg)};
`;

fs.writeFileSync(path.join(root, "services", "embedded-html.mjs"), embeddedCode);

console.log("Built Bytes unified Cloudflare bundle into dist/ and services/embedded-html.mjs.");
