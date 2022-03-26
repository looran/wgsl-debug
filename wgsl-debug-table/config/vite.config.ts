import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

export default defineConfig({
  plugins: [
  	checker({ typescript: { tsconfigPath: "../config/tsconfig.json", } }),
  ],
  build: {
    sourcemap: true,
    lib: {
      entry: "wgsl-debug-table.ts",
      name: "wgsl-debug-table",
      fileName: (format) => `wgsl-debug-table.${format}.js`,
    },
  },
});
