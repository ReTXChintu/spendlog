import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // The monorepo keeps a single .env at the repo root instead of one per
  // app. Only VITE_-prefixed vars from it are exposed to browser code.
  envDir: path.resolve(__dirname, "..", ".."),
});
