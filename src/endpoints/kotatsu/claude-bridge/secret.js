import { randomBytes } from 'node:crypto';

import { SecretManager, SECRET_KEYS } from '../../secrets.js';

/**
 * The fixed secret id the bridge owns. It is fixed on purpose: the shipped "Claude"
 * connection profile carries `secret-id: kotatsu-ccrp`, so the same id has to mean the
 * same token on a fresh install and on an install that already had one.
 */
export const BRIDGE_SECRET_ID = 'kotatsu-ccrp';
export const BRIDGE_SECRET_LABEL = 'Kotatsu Claude bridge';
export const BRIDGE_SECRET_KEY = SECRET_KEYS.CUSTOM;
export const MIN_TOKEN_LENGTH = 32;

/**
 * Mints a bearer token. 32 random bytes render as 43 base64url characters, comfortably
 * over the 32-character floor the old installer enforced.
 * @returns {string} A fresh token
 */
export function generateBridgeToken() {
    return randomBytes(32).toString('base64url');
}

/**
 * Reads the named secrets stored under `api_key_custom` for one user.
 * @param {import('../../../users.js').UserDirectoryList} directories User directories
 * @returns {import('../../secrets.js').SecretValue[]} The named-secret entries (possibly empty)
 */
function readCustomSecrets(directories) {
    const secrets = new SecretManager(directories).getAllSecrets();
    const entries = secrets[BRIDGE_SECRET_KEY];
    return Array.isArray(entries) ? entries : [];
}

/**
 * Ensures one user has a usable bridge token under {@link BRIDGE_SECRET_ID}.
 *
 * An existing entry with a long enough value is ADOPTED, never rotated — his home
 * install already carries this id with a live token wired into a selected connection
 * profile, and rotating it would silently break the profile on the first boot after a
 * pull. Only a missing (or too-short, i.e. never really provisioned) entry is written.
 * @param {import('../../../users.js').UserDirectoryList} directories User directories
 * @param {string|null} [token] Token to store when one has to be written; a fresh one is minted when null
 * @returns {{value: string, adopted: boolean, active: boolean, label: string}} The token in force for this user
 */
export function ensureBridgeSecret(directories, token = null) {
    const entries = readCustomSecrets(directories);
    const existing = entries.find(entry => entry?.id === BRIDGE_SECRET_ID);

    if (existing && typeof existing.value === 'string' && existing.value.length >= MIN_TOKEN_LENGTH) {
        return {
            value: existing.value,
            adopted: true,
            active: existing.active === true,
            label: existing.label,
        };
    }

    const value = token ?? generateBridgeToken();
    const label = existing?.label || BRIDGE_SECRET_LABEL;
    const stored = new SecretManager(directories)
        .upsertSecretById(BRIDGE_SECRET_KEY, BRIDGE_SECRET_ID, value, label);

    return {
        value: stored.value,
        adopted: false,
        active: stored.active === true,
        label: stored.label,
    };
}

/**
 * Ensures every user directory carries the bridge token, and returns the one the
 * listener will accept.
 *
 * Single-user mode has exactly one directory. In multi-user mode the first user's token
 * is the bearer and every other user gets the same value written, so one listener serves
 * the whole install. A later user who already had a DIFFERENT token under this id keeps
 * it (never rotate) and is warned about, rather than being quietly overwritten.
 * @param {import('../../../users.js').UserDirectoryList[]} directoriesList User directories
 * @param {object} [logger] Logger
 * @returns {{token: string, users: object[]}} The bearer token and a per-user summary
 */
export function ensureBridgeToken(directoriesList, logger = console) {
    const users = [];
    let token = null;

    for (const directories of directoriesList) {
        try {
            const result = ensureBridgeSecret(directories, token);
            if (token === null) {
                token = result.value;
            } else if (result.value !== token) {
                logger.warn?.(`[Claude bridge] ${directories.root} already has a different ${BRIDGE_SECRET_ID} token; leaving it alone. That user's client will need the first user's token, or delete the secret to have it re-provisioned.`);
            }
            users.push({
                root: directories.root,
                adopted: result.adopted,
                active: result.active,
                matchesBearer: result.value === token,
            });
        } catch (error) {
            logger.warn?.(`[Claude bridge] Could not provision the ${BRIDGE_SECRET_ID} secret for ${directories?.root}:`, error);
            users.push({ root: directories?.root, error: error instanceof Error ? error.message : String(error) });
        }
    }

    if (token === null) {
        throw new Error(`Could not read or write the ${BRIDGE_SECRET_ID} secret for any user directory`);
    }

    return { token, users };
}
