#!/usr/bin/env node
import process from 'node:process';
import webpack from 'webpack';
import publicLibConfig from './webpack.config.js';

console.log('Compiling frontend libraries...');

const compiler = webpack(publicLibConfig);

const exitCode = await new Promise((resolve) => {
    compiler.run((error, stats) => {
        if (error) {
            console.error('Failed to compile frontend libraries:', error);
        }

        const output = stats?.toString(publicLibConfig.stats);
        if (output) {
            console.log(output);
        }

        const failed = !!error || !!stats?.hasErrors();
        compiler.close(() => resolve(failed ? 1 : 0));
    });
});

process.exit(exitCode);
