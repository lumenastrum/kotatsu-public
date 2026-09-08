import path from 'node:path';
import dns from 'node:dns';
import Handlebars from 'handlebars';
import ipMatching from 'ip-matching';
import isDocker from 'is-docker';

import { filterValidIpPatterns, getIpFromRequest, getRealOrForwardedIp } from '../express-common.js';
import { color, getConfigValue, safeReadFileSync } from '../util.js';

const enableForwardedWhitelist = !!getConfigValue('enableForwardedWhitelist', false, 'boolean');
const whitelistDockerHosts = !!getConfigValue('whitelistDockerHosts', true, 'boolean');
/** @type {string[]} */
let whitelist = getConfigValue('whitelist', []);

whitelist = filterValidIpPatterns(whitelist, (entry, message) => `${color.red('Warning')}: Ignoring invalid whitelist entry ${color.yellow(entry)} - ${message}`);

/**
 * Resolves the IP addresses of Docker hostnames and adds them to the whitelist.
 * @returns {Promise<void>} Promise that resolves when the Docker hostnames are resolved
 */
async function addDockerHostsToWhitelist() {
    if (!whitelistDockerHosts || !isDocker()) {
        return;
    }

    const whitelistHosts = ['host.docker.internal', 'gateway.docker.internal'];

    for (const entry of whitelistHosts) {
        try {
            const result = await dns.promises.lookup(entry);
            console.info(`Resolved whitelist hostname ${color.green(entry)} to IPv${result.family} address ${color.green(result.address)}`);
            whitelist.push(result.address);
        } catch (e) {
            console.warn(`Failed to resolve whitelist hostname ${color.red(entry)}: ${e.message}`);
        }
    }
}

/**
 * Returns a middleware function that checks if the client IP is in the whitelist.
 * @returns {Promise<import('express').RequestHandler>} Promise that resolves to the middleware function
 */
export default async function getWhitelistMiddleware() {
    const forbiddenWebpage = Handlebars.compile(
        safeReadFileSync(path.join(globalThis.DATA_ROOT, '_errors', 'forbidden-by-whitelist.html')) ?? '',
    );

    const noLogPaths = [
        '/favicon.ico',
    ];

    await addDockerHostsToWhitelist();

    return function (req, res, next) {
        const clientIp = getIpFromRequest(req);
        const forwardedIp = enableForwardedWhitelist && getRealOrForwardedIp(req);
        const userAgent = req.headers['user-agent'];

        /**
         * Checks if an IP address matches any entry in the whitelist.
         * @param {string[]} whitelist - The list of whitelisted IPs/CIDRs
         * @param {string} ip - The IP address to check
         * @returns {boolean} True if the IP matches any whitelist entry
         */
        function isIPInWhitelist(whitelist, ip) {
            return whitelist.some(x => ipMatching.matches(ip, ipMatching.getMatch(x)));
        }

        //clientIp = req.connection.remoteAddress.split(':').pop();
        if (!isIPInWhitelist(whitelist, clientIp)
            || (forwardedIp && !isIPInWhitelist(whitelist, forwardedIp))
        ) {
            // Log the connection attempt with real IP address
            const ipDetails = forwardedIp
                ? `${clientIp} (forwarded from ${forwardedIp})`
                : clientIp;

            if (!noLogPaths.includes(req.path)) {
                console.warn(
                    color.red(
                        `Blocked connection from ${ipDetails}; User Agent: ${userAgent}\n\tTo allow this connection, add its IP address to the whitelist or disable whitelist mode by editing config.yaml in the root directory of your SillyTavern installation.\n`,
                    ),
                );
            }

            return res.status(403).send(forbiddenWebpage({ ipDetails }));
        }
        next();
    };
}
