import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import publicLibConfig from '../../webpack.config.js';
import { color } from '../util.js';

const outputDirectory = String(publicLibConfig.output?.path);
const outputFile = String(publicLibConfig.output?.filename);
const outputPath = path.join(outputDirectory, outputFile);

/**
 * Verify that the prebuilt frontend library bundle exists, and exit with an explanation if it doesn't.
 * The bundle is a build artifact: the server never compiles it.
 */
export function verifyPublicLibBundle() {
    if (fs.existsSync(outputPath)) {
        return;
    }

    console.error(color.red(`Frontend libraries are not built: ${outputPath} is missing.`));
    console.error(`Run ${color.blue('npm run build:lib')} to build them, then start the server again.`);
    process.exit(1);
}

/**
 * Serve the prebuilt frontend library bundle from the build output directory.
 * @returns {import('express').RequestHandler}
 */
export default function getPublicLibServeMiddleware() {
    return function publicLibMiddleware(req, res, next) {
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            return res.sendFile(outputFile, { root: outputDirectory });
        }

        next();
    };
}
