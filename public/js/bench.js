/* OpenVibe.Bench pages work without JavaScript; the main session designs this room later. */
/* The gallery (B9): at most six frames live at a time; the rest wait as a still until the reader asks. */
(function () {
    'use strict';

    var LIVE = 6;

    function gallery() {
        var grid = document.querySelector('[data-gallery="1"]');
        if (!grid) return;
        var shots = Array.prototype.slice.call(grid.querySelectorAll('.ga-shot'));
        var live = shots.filter(function (s) { return s.getAttribute('data-live') === '1'; });

        function release(shot) {
            var frame = shot.querySelector('iframe.ga-frame');
            if (!frame) return;
            if (shot.getAttribute('data-server') === '1') return;   // the first frames stay live
            var still = document.createElement('button');
            still.type = 'button';
            still.className = 'ga-still';
            still.setAttribute('data-ga-still', '1');
            still.setAttribute('aria-label', 'Load the live frame');
            var note = document.createElement('span');
            note.className = 'ga-still-note';
            note.textContent = 'Live frame, on tap';
            still.appendChild(note);
            frame.parentNode.replaceChild(still, frame);
            shot.removeAttribute('data-live');
            live = live.filter(function (s) { return s !== shot; });
        }

        function activate(shot) {
            if (!shot || shot.getAttribute('data-live') === '1') return;
            var src = shot.getAttribute('data-src');
            if (!src) return;
            while (live.length >= LIVE) {
                var victim = null;
                for (var i = 0; i < live.length; i++) {
                    if (live[i].getAttribute('data-server') !== '1') { victim = live[i]; break; }
                }
                if (!victim) return;
                release(victim);
            }
            var still = shot.querySelector('[data-ga-still]');
            var frame = document.createElement('iframe');
            frame.className = 'ga-frame';
            frame.setAttribute('src', src);
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            frame.setAttribute('referrerpolicy', 'no-referrer');
            frame.setAttribute('loading', 'lazy');
            frame.setAttribute('title', 'Output');
            if (still && still.parentNode) still.parentNode.replaceChild(frame, still);
            shot.setAttribute('data-live', '1');
            live.push(shot);
        }

        grid.addEventListener('click', function (event) {
            var target = event.target;
            var shot = target && target.closest ? target.closest('.ga-shot') : null;
            if (shot) activate(shot);
        });

        if ('IntersectionObserver' in window) {
            var observer = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) activate(entry.target);
                });
            }, { rootMargin: '320px' });
            shots.forEach(function (shot) { observer.observe(shot); });
        } else {
            shots.forEach(activate);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', gallery);
    else gallery();
}());
