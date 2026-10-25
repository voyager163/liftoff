import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The browser calls the API at /api on the page's own origin. The dev server
// and `vite preview` forward it to the API, as nginx does in the container.
const api = process.env.API_URL ?? "http://127.0.0.1:8000";
const proxy = {
  "/api": {
    target: api,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
  },
};

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
});
