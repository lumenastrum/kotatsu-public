import path from 'node:path';
import { serverDirectory } from './src/server-directory.js';

/** Directory where build artifacts are emitted. */
export const distDirectory = path.join(serverDirectory, 'dist');

/**
 * Webpack configuration for the frontend vendor bundle.
 *
 * This is a build-time config only: the bundle is compiled ahead of time with
 * `npm run build:lib` and served from the output directory as a static file.
 * The server never runs Webpack.
 * @type {import('webpack').Configuration}
 */
export default {
    mode: 'production',
    entry: path.join(serverDirectory, 'public/lib.js'),
    cache: {
        type: 'filesystem',
        cacheDirectory: path.join(distDirectory, '.webpack-cache'),
        store: 'pack',
        compression: 'gzip',
    },
    devtool: false,
    watch: false,
    module: {},
    stats: {
        preset: 'minimal',
        assets: false,
        modules: false,
        colors: true,
        timings: true,
    },
    experiments: {
        outputModule: true,
    },
    performance: {
        hints: false,
    },
    output: {
        path: distDirectory,
        filename: 'lib.js',
        libraryTarget: 'module',
    },
};
