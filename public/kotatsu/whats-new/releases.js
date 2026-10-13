/**
 * What's New — the notes, one entry per release that has something to show (`state.js` decides
 * when). Newest first by convention; `state.js` sorts anyway.
 *
 * Each card's clip lives at `media/<version>/<card id>.{webm,mp4,webp}`: a short muted loop cut
 * from a real recording (720×450), with the webp as its poster and the reduced-motion still.
 * Card copy is the UI's own voice, plain; Mikan-chan's bubble lines live in
 * `brand/mascot/lines.js` like every other line of hers. `wiki` is a page of the public wiki
 * (and an anchor on it); keep the anchors in step with that page's headings.
 */

/** The public wiki every card's "Read more" points into. */
export const WIKI_BASE = 'https://github.com/lumenastrum/kotatsu-public/wiki/';

/** @type {ReadonlyArray<import('./state.js').Release>} */
export const RELEASES = Object.freeze([
    Object.freeze({
        version: '0.7.0',
        title: 'Sprites',
        cards: [
            {
                id: 'stage',
                title: 'Faces on the stage',
                body: 'Set Messages to Sprites in Settings → Appearance, and your cast stands beside the chat. Each finished reply picks the face that fits it. In a scene, whoever speaks steps forward.',
                line: 'whatsNewStage',
                wiki: 'Sprites#on-the-stage',
            },
            {
                id: 'generate',
                title: 'A whole set from one drawing',
                body: 'In the Card Studio, open Sprites and choose Generate. Pick the drawing you like best, and Kotatsu paints every expression from it, as a full body and as a bust. Your own ComfyUI does the drawing.',
                line: 'whatsNewGenerate',
                wiki: 'Sprites#generate-a-set',
            },
            {
                id: 'touchup',
                title: 'Touch up the edges',
                body: 'A patch of background left behind? Touch-up’s wand clears it, and with Apply to matching sprites the fix lands on the whole set at once.',
                line: 'whatsNewTouchup',
                wiki: 'Sprites#touch-up',
            },
        ],
        notes: [
            'Already have sprites? Upload them one by one, or import a pack (.zip), in the Card Studio’s Sprites tab.',
            'The Pictures sheet draws in two steps now: set up the scene, then Write scene. It opens on the model you used last.',
            'Generate says up front when ComfyUI isn’t answering, with a button to set it up.',
            'Claude Code is optional, and its notice now says so. Don’t show again turns it off.',
        ],
    }),
    Object.freeze({
        version: '0.6.0',
        title: 'Pictures',
        cards: [
            {
                id: 'draw',
                title: 'Draw the moment',
                body: 'Choose the paintbrush on a message, or Draw a picture in the wand menu. The writer drafts a prompt from the scene; change what you like, then Draw. Mikan-chan paints while you wait.',
                line: 'whatsNewDraw',
                wiki: 'Pictures#drawing-in-the-chat',
            },
            {
                id: 'comfy',
                title: 'Your own ComfyUI',
                body: 'Point Settings → Pictures at your ComfyUI. The setup guide names any model that is missing, with a link to download it. Pick a model and preset in the sheet, and give a card its LoRAs.',
                line: 'whatsNewComfy',
                wiki: 'Pictures#local-comfyui',
            },
        ],
        notes: [
            'No GPU? Pictures can also draw with your own OpenAI or Google AI Studio key, the one you added under Connection.',
            'The old Image Generation extension is gone. Your settings from it carry over to Pictures.',
            'Kotatsu runs in Docker: see docker/ in the repository. Thank you, @siestamode, for the first outside contribution.',
        ],
    }),
    Object.freeze({
        version: '0.5.0',
        title: 'Scenes',
        cards: [
            {
                id: 'rooms',
                title: 'Who’s in the room?',
                body: 'A scene is one chat with several characters. Choose New scene in the library, seat the cast, and set the scene in a line or two.',
                line: 'whatsNewRooms',
                wiki: 'Scenes#setting-up-a-scene',
            },
            {
                id: 'mentions',
                title: 'You choose who answers',
                body: 'Write @Hana and @Pip, and they answer in that order. Or tap a face on the stage and choose Speak now.',
                line: 'whatsNewMentions',
                wiki: 'Scenes#choosing-who-speaks',
            },
            {
                id: 'talk',
                title: 'Let them talk',
                body: 'The cast carries the scene on its own, one reply after another. The stage shows who is writing and who is next. Type, or press it again, to take the floor back.',
                line: 'whatsNewTalk',
                wiki: 'Scenes#let-them-talk',
            },
            {
                id: 'narrator',
                title: 'A narrator for the world',
                body: 'Seat a narrator in Edit scene, and it voices the place, the weather and everyone outside the cast. It never speaks for your characters.',
                line: 'whatsNewNarrator',
                wiki: 'Scenes#the-narrator',
            },
        ],
        notes: [
            'Kotatsu Nabe 0.4 knows about scenes. If you never edited your copy, it updates itself and keeps a backup.',
            'MiMo’s safety-filter notice no longer ends up inside the reply.',
        ],
    }),
]);
