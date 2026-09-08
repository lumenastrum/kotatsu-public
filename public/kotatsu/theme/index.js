import { initThemeLoader } from './loader.js';

/**
 * Registers the Kotatsu theme-pack loader at the sanctioned first-load seam.
 * @returns {Promise<void>}
 */
export async function initKotatsuTheme() {
    await initThemeLoader();
}
