import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  // The release script stamps one version across every app; baking it in
  // here is what lets Settings say which build is being served.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173 },
  // The monorepo keeps a single .env at the repo root instead of one per
  // app. Only VITE_-prefixed vars from it are exposed to browser code.
  envDir: path.resolve(__dirname, "..", ".."),
});
