/** First-party provider metadata shared by the cards and saved-connection labels. */

/**
 * @typedef {object} Provider
 * @property {string} source Chat Completion source id
 * @property {string} name What people call it
 * @property {string} secret Secret key id (secrets.js SECRET_KEYS)
 * @property {string} keyField Core's key input id
 * @property {string} modelKey `oai_settings` key holding this source's model
 * @property {string} hint Where to get a key
 * @property {string} [placeholderModel] A model value that means "no model picked here" and isn't shown
 */

/** @type {ReadonlyArray<Provider>} */
export const PROVIDERS = Object.freeze([
    { source: 'claude', name: 'Anthropic API', secret: 'api_key_claude', keyField: 'api_key_claude', modelKey: 'claude_model', hint: 'console.anthropic.com' },
    { source: 'openai', name: 'OpenAI', secret: 'api_key_openai', keyField: 'api_key_openai', modelKey: 'openai_model', hint: 'platform.openai.com' },
    { source: 'makersuite', name: 'Google AI Studio', secret: 'api_key_makersuite', keyField: 'api_key_makersuite', modelKey: 'google_model', hint: 'aistudio.google.com' },
    { source: 'deepseek', name: 'DeepSeek', secret: 'api_key_deepseek', keyField: 'api_key_deepseek', modelKey: 'deepseek_model', hint: 'platform.deepseek.com' },
    { source: 'xai', name: 'xAI', secret: 'api_key_xai', keyField: 'api_key_xai', modelKey: 'xai_model', hint: 'console.x.ai' },
    // The one aggregator up here (decision 2026-10-03): it's what the roleplay world actually pastes a key for.
    { source: 'openrouter', name: 'OpenRouter', secret: 'api_key_openrouter', keyField: 'api_key_openrouter', modelKey: 'openrouter_model', hint: 'openrouter.ai', placeholderModel: 'OR_Website' },
]);

/** @type {Readonly<Record<string, string>>} */
export const PROVIDER_NAMES = Object.freeze(Object.fromEntries(PROVIDERS.map(({ source, name }) => [source, name])));
