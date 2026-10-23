// Trailer: swap the poster for the real player only when asked. Self-hosted: the 16:9 cut, or the vertical one on a
// phone (the same 640px line the CSS uses to turn the box 9:16). Nothing downloads until the click.
const PORTRAIT = '(max-width: 640px)';
for (const box of document.querySelectorAll('.trailer[data-video]')) {
  box.querySelector('button')?.addEventListener('click', () => {
    const video = document.createElement('video');
    const portrait = box.dataset.videoPortrait && matchMedia(PORTRAIT).matches;
    video.src = portrait ? box.dataset.videoPortrait : box.dataset.video;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-label', 'Kotatsu trailer');
    box.replaceChildren(video);
    video.play().catch(() => { /* blocked autoplay: the controls are there */ });
    video.focus();
  });
}
for (const box of document.querySelectorAll('.trailer[data-yt]')) {
  box.querySelector('button')?.addEventListener('click', () => {
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${box.dataset.yt}?autoplay=1&rel=0`;
    frame.title = 'Kotatsu trailer';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    box.replaceChildren(frame);
    frame.focus();
  });
}

// Theme switch: the page wears a theme the way Kotatsu does, one attribute on <html>.
const THEME_BG = { natsumikan: '#fbecd2', bluehour: '#11131a' };
function showTheme(theme) {
  document.querySelectorAll('[data-set-theme]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.setTheme === theme)));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[theme]);
}
showTheme(document.documentElement.dataset.theme);
document.querySelectorAll('[data-set-theme]').forEach(button => {
  button.addEventListener('click', () => {
    const theme = button.dataset.setTheme;
    if (theme === document.documentElement.dataset.theme) return;
    document.body.classList.add('theme-easing');
    document.documentElement.dataset.theme = theme;
    showTheme(theme);
    try { localStorage.setItem('kotatsu-site-theme', theme); } catch (e) { /* private window: fine */ }
    setTimeout(() => document.body.classList.remove('theme-easing'), 320);
  });
});

// Version: read the latest public release; the static number stays if this fails.
fetch('https://api.github.com/repos/lumenastrum/kotatsu-public/releases/latest')
  .then(r => (r.ok ? r.json() : null))
  .then(rel => {
    const tag = rel?.tag_name?.replace(/^v/, '');
    if (tag) document.querySelectorAll('[data-version]').forEach(el => { el.textContent = tag; });
  })
  .catch(() => {});
