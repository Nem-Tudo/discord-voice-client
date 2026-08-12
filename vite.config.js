const path = require('path');
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
    root: 'src/app',
    base: "./",
    plugins: [react()],
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, 'src/app/index.html'),
                logs: path.resolve(__dirname, 'src/app/logs.html')
            }
        }
    }
});
