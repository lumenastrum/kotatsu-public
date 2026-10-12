/**
 * Pictures v0, slice B — `/imagine` (docs/pictures-v0.md §2.4).
 *
 * `/imagine [purpose] [free text]`, aliases `sd`, `img`, `image` (stock's names, kept so old
 * STscript keeps landing). The purpose word is optional: `moment | char | me | place | free`, plus
 * stock's own words (`last`, `you`, `yourself`, `face`, `background`, `scene`); free text alone
 * means Free. `/imagine` with nothing opens the sheet. `quiet=true` draws without the sheet and
 * returns the first picture's url when it lands, so a script can pipe it.
 *
 * Registered once from the rails install, the way `/kotatsu-recount` is (`prompts/render-seam.js`):
 * additive under CONTRACT §0, idempotent, never removed (core has no deregistration). Under the
 * classic layout the command answers that Pictures are part of rails.
 */

import { SlashCommand } from '../../scripts/slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../scripts/slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../scripts/slash-commands/SlashCommandParser.js';
import { isTrueBoolean } from '../../scripts/utils.js';
import { INITIATORS, PURPOSES } from './contract.js';
import { railsActive, toast } from './doors.js';
import { openPictureSheet, quickPicture } from './picture-actions.js';
import { PURPOSE_WORDS, parseImagineArgs } from './picture-model.js';

export const IMAGINE_COMMAND = 'imagine';
export const IMAGINE_ALIASES = Object.freeze(['sd', 'img', 'image']);

let registered = false;

/**
 * @param {Record<string, any>} args Named arguments.
 * @param {unknown} text The unnamed argument.
 * @returns {Promise<string>}
 */
async function imagine(args, text) {
    if (!railsActive()) {
        toast('info', 'Pictures are part of the rails layout.');
        return '';
    }
    const { purpose, free } = parseImagineArgs(typeof text === 'string' ? text : String(text ?? ''));
    if (!isTrueBoolean(String(args?.quiet ?? ''))) {
        await openPictureSheet({
            purpose: purpose ?? undefined,
            prefill: free ? { free } : {},
            initiator: INITIATORS.COMMAND,
        });
        return '';
    }
    try {
        const result = await quickPicture({ purpose: purpose ?? PURPOSES.MOMENT, free });
        return result?.url ?? '';
    } catch (error) {
        toast('error', error instanceof Error ? error.message : String(error));
        return '';
    }
}

/**
 * Registers `/imagine` and its aliases. Idempotent.
 * @returns {void}
 */
export function registerPictureCommands() {
    if (registered) return;
    registered = true;
    try {
        const existing = SlashCommandParser.commands;
        if (existing && Object.hasOwn(existing, IMAGINE_COMMAND)) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: IMAGINE_COMMAND,
            aliases: [...IMAGINE_ALIASES],
            callback: imagine,
            returns: 'the url of the first picture, when quiet=true',
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'quiet',
                    description: 'draw without opening the sheet',
                    typeList: [ARGUMENT_TYPE.BOOLEAN],
                    defaultValue: 'false',
                    enumList: ['true', 'false'],
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: `what to draw: an optional purpose word (${Object.keys(PURPOSE_WORDS).join(', ')}) and a description`,
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
            ],
            helpString: 'Opens the Picture sheet. With a purpose word (moment, char, me, place, free) it starts on that '
                + 'purpose; with only a description it starts on Free with the description filled in. '
                + 'quiet=true draws straight away and returns the picture\'s url.',
        }));
    } catch (error) {
        console.error('[Pictures] /imagine could not be registered', error);
    }
}
