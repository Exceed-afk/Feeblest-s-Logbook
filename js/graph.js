/* Graph view: notes are dots, [[links]] are lines. Sealed notes are drawn in
   the seal colour. Drag a dot to move it, click one to open that note. */
(function (root) {
  'use strict';

  function create(canvas, data, opts) {
    const ctx = canvas.getContext('2d');
    const colors = opts.colors();

    const nodes = data.nodes.map(function (n) {
      return { id: n.id, label: n.label, locked: !!n.locked, x: 0, y: 0, vx: 0, vy: 0, deg: 0, fixed: false };
    });
    const byId = new Map(nodes.map(function (n) { return [n.id, n]; }));
    const edges = [];
    data.edges.forEach(function (e) {
      const a = byId.get(e[0]);
      const b = byId.get(e[1]);
      if (a && b) {
        edges.push([a, b]);
        a.deg++;
        b.deg++;
      }
    });

    let w = 300;
    let h = 300;
    let raf = 0;
    let alpha = 1;
    let hover = null;
    let drag = null;
    let start = null;
    let dead = false;

    function radius(n) { return 5 + Math.min(8, Math.sqrt(n.deg) * 2.6); }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = root.devicePixelRatio || 1;
      w = Math.max(200, rect.width);
      h = Math.max(200, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function seed() {
      const r = Math.min(w, h) / 3;
      nodes.forEach(function (n, i) {
        const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
        n.x = w / 2 + Math.cos(a) * r + (Math.random() - 0.5) * 12;
        n.y = h / 2 + Math.sin(a) * r + (Math.random() - 0.5) * 12;
      });
    }

    function tick() {
      const cx = w / 2;
      const cy = h / 2;

      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          const d = Math.sqrt(d2);
          const f = 2600 / d2;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }

      edges.forEach(function (e) {
        const a = e[0];
        const b = e[1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 90) * 0.03;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });

      nodes.forEach(function (n) {
        n.vx += (cx - n.x) * 0.012;
        n.vy += (cy - n.y) * 0.012;
        if (n.fixed) {
          n.vx = 0;
          n.vy = 0;
          return;
        }
        n.vx = Math.max(-8, Math.min(8, n.vx * 0.8));
        n.vy = Math.max(-8, Math.min(8, n.vy * 0.8));
        n.x = Math.max(14, Math.min(w - 14, n.x + n.vx * alpha));
        n.y = Math.max(14, Math.min(h - 24, n.y + n.vy * alpha));
      });
    }

    function shorten(text) {
      return text.length > 26 ? text.slice(0, 25) + '\u2026' : text;
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      const focus = hover || byId.get(opts.currentId) || null;

      ctx.lineWidth = 1;
      edges.forEach(function (e) {
        const hot = focus && (e[0] === focus || e[1] === focus);
        ctx.strokeStyle = hot ? colors.accent : colors.line;
        ctx.beginPath();
        ctx.moveTo(e[0].x, e[0].y);
        ctx.lineTo(e[1].x, e[1].y);
        ctx.stroke();
      });

      nodes.forEach(function (n) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2);
        ctx.fillStyle = n.locked ? colors.seal : colors.node;
        ctx.fill();
        if (n.id === opts.currentId) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = colors.ink;
          ctx.stroke();
        }
      });

      ctx.font = '13px ' + colors.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const showAll = nodes.length <= 30;
      nodes.forEach(function (n) {
        const important = n === hover || n.id === opts.currentId;
        if (!showAll && !important && n.deg < 3) return;
        ctx.fillStyle = important ? colors.ink : colors.muted;
        ctx.fillText(shorten(n.label), n.x, n.y + radius(n) + 4);
      });
    }

    function loop() {
      raf = 0;
      if (dead) return;
      tick();
      draw();
      alpha *= 0.985;
      if (alpha > 0.02 || drag) raf = root.requestAnimationFrame(loop);
    }

    function wake(a) {
      alpha = Math.max(alpha, a || 0.5);
      if (!raf && !dead) raf = root.requestAnimationFrame(loop);
    }

    function point(e) {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function pick(x, y) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const r = radius(n) + 5;
        if ((n.x - x) * (n.x - x) + (n.y - y) * (n.y - y) <= r * r) return n;
      }
      return null;
    }

    function onDown(e) {
      const p = point(e);
      const n = pick(p.x, p.y);
      if (!n) return;
      drag = n;
      start = p;
      n.fixed = true;
      canvas.setPointerCapture(e.pointerId);
      wake(0.3);
    }

    function onMove(e) {
      const p = point(e);
      if (drag) {
        drag.x = p.x;
        drag.y = p.y;
        wake(0.3);
        return;
      }
      const n = pick(p.x, p.y);
      if (n !== hover) {
        hover = n;
        canvas.style.cursor = n ? 'pointer' : 'default';
        draw();
      }
    }

    function onUp(e) {
      if (!drag) return;
      const n = drag;
      const p = point(e);
      const moved = Math.hypot(p.x - start.x, p.y - start.y);
      n.fixed = false;
      drag = null;
      wake(0.3);
      if (moved < 4 && opts.onOpen) opts.onOpen(n.id);
    }

    function onLeave() {
      if (hover && !drag) {
        hover = null;
        draw();
      }
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);

    let observer = null;
    if (root.ResizeObserver) {
      observer = new root.ResizeObserver(function () {
        if (dead) return;
        resize();
        draw();
      });
      observer.observe(canvas);
    }

    resize();
    seed();
    for (let i = 0; i < 120; i++) tick();
    alpha = 0.4;
    draw();
    wake(0.4);

    return {
      destroy: function () {
        dead = true;
        if (raf) root.cancelAnimationFrame(raf);
        if (observer) observer.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointerleave', onLeave);
      }
    };
  }

  root.JournalGraph = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
