import { getIpFromRequest } from '../../../express-common.js';

/**
 * Who may change phone access (docs/phone-v0.md §3.3). Pure over their inputs.
 */

const FORWARD_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded'];

/**
 * The computer itself: a loopback socket and no proxy headers.
 * @param {import('express').Request} request
 * @returns {boolean}
 */
export function isLoopbackRequest(request) {
    const ip = getIpFromRequest(request);
    if (ip !== '127.0.0.1' && ip !== '::1') return false;
    return !FORWARD_HEADERS.some(header => header in request.headers);
}

/**
 * Who set `listen` if not config.yaml: a launch flag beats the environment, which beats the file.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {null|'cli'|'env'}
 */
export function listenLock(argv, env) {
    if (argv.some(arg => /^--(no-)?listen(=|$)/.test(arg))) return 'cli';
    if ('SILLYTAVERN_LISTEN' in env) return 'env';
    return null;
}
