const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
    root: 'src/app',
    base: "./",
    plugins: [react()],
    build: {
        outDir: '../dist',
        emptyOutDir: true
    }
});
