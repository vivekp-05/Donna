import React, { useEffect, useRef, useState } from 'react';
import { TERM_COLORS, FLOW_DIRECT, FLOW_STORE } from '../theme';

/**
 * One-shot celebration confetti for the hackathon win — scoped to the win
 * banner, NOT a page overlay. The canvas is a small halo positioned around the
 * banner (it mounts inside `.win-banner`) at z-index -1, so every piece pops
 * from BEHIND the label: above the ribbon's background, below the label and
 * its neighbors. A burst fires on load and a second ~1.6s later, then the
 * canvas unmounts for good.
 *
 * Hand-rolled on a <canvas> rather than pulled in as a dependency — two rAF
 * bursts of palette-colored rectangles with gravity, drag and spin, in Donna's
 * own colors (the score-term palette + the two route colors). Honors
 * prefers-reduced-motion by not running at all, and stands down immediately
 * when the narrow ribbon has display:none'd the banner (zero-size canvas).
 */

const COLORS = [...Object.values(TERM_COLORS), FLOW_DIRECT, FLOW_STORE];
const GRAVITY = 0.15;   // px/frame² — gentle; the halo is only ~120px tall
const DRAG = 0.985;
const FADE_MS = 350;    // opacity ramp at the end of a piece's life
const SECOND_POP_MS = 1600;

interface Piece {
  x: number; y: number; vx: number; vy: number;
  w: number; h: number; rot: number; vr: number;
  color: string; born: number; life: number;
}

export function WinConfetti(): React.JSX.Element | null {
  const ref = useRef<HTMLCanvasElement>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setDone(true); return; }
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) { setDone(true); return; }

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) { setDone(true); return; }   // banner hidden — nothing to celebrate on
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    // Pop from the center of the label, in the halo canvas's own coordinates.
    const banner = canvas.parentElement!.getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const ox = banner.left + banner.width / 2 - box.left;
    const oy = banner.top + banner.height / 2 - box.top;

    const pieces: Piece[] = [];
    const burst = (n: number) => {
      const now = performance.now();
      for (let i = 0; i < n; i++) {
        // Outward in (nearly) every direction, biased upward; gravity brings
        // the rest of the arc back down through the label.
        const angle = (-90 + (Math.random() - 0.5) * 300) * (Math.PI / 180);
        const speed = 2.5 + Math.random() * 5;
        pieces.push({
          x: ox, y: oy,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          w: 3 + Math.random() * 3, h: 5 + Math.random() * 4,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25,
          color: COLORS[i % COLORS.length],
          born: now, life: 1000 + Math.random() * 600,
        });
      }
    };

    let raf = 0;
    let secondFired = false;
    const t2 = window.setTimeout(() => { burst(55); secondFired = true; }, SECOND_POP_MS);

    const tick = () => {
      const now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        const age = now - p.born;
        if (age > p.life || p.y > h + 10) { pieces.splice(i, 1); continue; }
        p.vy += GRAVITY; p.vx *= DRAG; p.vy *= DRAG;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        ctx.globalAlpha = age > p.life - FADE_MS ? (p.life - age) / FADE_MS : 1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      // Both pops done and every piece dead → unmount for good.
      if (pieces.length === 0 && secondFired) { setDone(true); return; }
      raf = window.requestAnimationFrame(tick);
    };

    burst(70);
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t2);
    };
  }, []);

  if (done) return null;
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}
