import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

export default defineConfig({
  plugins: [
  	checker({ typescript: { tsconfigPath: "config/tsconfig.json", } }),
  ],
  build: {
    sourcemap: true,
    lib: {
      entry: "wgsl-debug.ts",
      name: "wgsl-debug",
      fileName: (format) => `wgsl-debug.${format}.js`,
    },
  },
});
