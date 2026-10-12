import fetch from 'node-fetch';
import express from 'express';
import { AIHorde, ModelInterrogationFormTypes, HordeAsyncRequestStates } from '@zeldafan0225/ai_horde';
import { getVersion, delay, Cache } from '../util.js';
import { readSecret, SECRET_KEYS } from './secrets.js';

const ANONYMOUS_KEY = '0000000000';
const HORDE_TEXT_MODEL_METADATA_URL = 'https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json';
const cache = new Cache(60 * 1000);
export const router = express.Router();

/**
 * Returns the AIHorde client agent.
 * @returns {Promise<string>} AIHorde client agent
 */
async function getClientAgent() {
    const version = await getVersion();
    return version?.agent || 'SillyTavern:UNKNOWN:Cohee#1207';
}

/**
 * Returns the AIHorde client.
 * @returns {Promise<AIHorde>} AIHorde client
 */
async function getHordeClient() {
    return new AIHorde({
        client_agent: await getClientAgent(),
    });
}

router.post('/text-workers', async (request, response) => {
    try {
        const cachedWorkers = cache.get('workers');

        if (cachedWorkers && !request.body.force) {
            return response.send(cachedWorkers);
        }

        const agent = await getClientAgent();
        const fetchResult = await fetch('https://aihorde.net/api/v2/workers?type=text', {
            headers: {
                'Client-Agent': agent,
            },
        });
        const data = await fetchResult.json();
        cache.set('workers', data);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

async function getHordeTextModelMetadata() {
    const response = await fetch(HORDE_TEXT_MODEL_METADATA_URL);
    return await response.json();
}

async function mergeModelsAndMetadata(models, metadata) {
    return models.map(model => {
        const metadataModel = metadata[model.name];
        if (!metadataModel) {
            return { ...model, is_whitelisted: false };
        }
        return { ...model, ...metadataModel, is_whitelisted: true };
    });
}

router.post('/text-models', async (request, response) => {
    try {
        const cachedModels = cache.get('models');
        if (cachedModels && !request.body.force) {
            return response.send(cachedModels);
        }

        const agent = await getClientAgent();
        const fetchResult = await fetch('https://aihorde.net/api/v2/status/models?type=text', {
            headers: {
                'Client-Agent': agent,
            },
        });

        let data = await fetchResult.json();

        // attempt to fetch and merge models metadata
        try {
            const metadata = await getHordeTextModelMetadata();
            data = await mergeModelsAndMetadata(data, metadata);
        } catch (error) {
            console.error('Failed to fetch metadata:', error);
        }

        cache.set('models', data);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/status', async (_, response) => {
    try {
        const agent = await getClientAgent();
        const fetchResult = await fetch('https://aihorde.net/api/v2/status/heartbeat', {
            headers: {
                'Client-Agent': agent,
            },
        });

        return response.send({ ok: fetchResult.ok });
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/cancel-task', async (request, response) => {
    try {
        const taskId = request.body.taskId;
        const agent = await getClientAgent();
        const fetchResult = await fetch(`https://aihorde.net/api/v2/generate/text/status/${taskId}`, {
            method: 'DELETE',
            headers: {
                'Client-Agent': agent,
            },
        });

        const data = await fetchResult.json();
        console.info(`Cancelled Horde task ${taskId}`);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/task-status', async (request, response) => {
    try {
        const taskId = request.body.taskId;
        const agent = await getClientAgent();
        const fetchResult = await fetch(`https://aihorde.net/api/v2/generate/text/status/${taskId}`, {
            headers: {
                'Client-Agent': agent,
            },
        });

        const data = await fetchResult.json();
        console.info(`Horde task ${taskId} status:`, data);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/generate-text', async (request, response) => {
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
    const url = 'https://aihorde.net/api/v2/generate/text/async';
    const agent = await getClientAgent();

    console.debug(request.body);
    try {
        const result = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(request.body),
            headers: {
                'Content-Type': 'application/json',
                'apikey': apiKey,
                'Client-Agent': agent,
            },
        });

        if (!result.ok) {
            const message = await result.text();
            console.error('Horde returned an error:', message);
            return response.send({ error: { message } });
        }

        const data = await result.json();
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
});

router.post('/caption-image', async (request, response) => {
    try {
        const api_key_horde = readSecret(request.user.directories, SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
        const ai_horde = await getHordeClient();
        const result = await ai_horde.postAsyncInterrogate({
            source_image: request.body.image,
            forms: [{ name: ModelInterrogationFormTypes.caption }],
        }, { token: api_key_horde });

        if (!result.id) {
            console.error('Image interrogation request is not satisfyable:', result.message || 'unknown error');
            return response.sendStatus(400);
        }

        const MAX_ATTEMPTS = 200;
        const CHECK_INTERVAL = 3000;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await delay(CHECK_INTERVAL);
            const status = await ai_horde.getInterrogationStatus(result.id);
            console.info(status);

            if (status.state === HordeAsyncRequestStates.done) {
                if (status.forms === undefined) {
                    console.error('Image interrogation request failed: no forms found.');
                    return response.sendStatus(500);
                }

                console.debug('Image interrogation result:', status);
                const caption = status?.forms[0]?.result?.caption || '';

                if (!caption) {
                    console.error('Image interrogation request failed: no caption found.');
                    return response.sendStatus(500);
                }

                return response.send({ caption });
            }

            if (status.state === HordeAsyncRequestStates.faulted || status.state === HordeAsyncRequestStates.cancelled) {
                console.error('Image interrogation request is not successful.');
                return response.sendStatus(503);
            }
        }
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/user-info', async (request, response) => {
    const api_key_horde = readSecret(request.user.directories, SECRET_KEYS.HORDE);

    if (!api_key_horde) {
        return response.send({ anonymous: true });
    }

    try {
        const ai_horde = await getHordeClient();
        const sharedKey = await (async () => {
            try {
                return await ai_horde.getSharedKey(api_key_horde);
            } catch {
                return null;
            }
        })();
        const user = await ai_horde.findUser({ token: api_key_horde });
        return response.send({ user, sharedKey, anonymous: false });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
