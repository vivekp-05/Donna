import React, { useEffect, useRef, useState } from 'react';
import { TERM_COLORS, FLOW_DIRECT, FLOW_STORE } from '../theme';

/**
 * One-shot celebration confetti for the hackathon win: a burst on app load and
 * a second one ~1.6s later, then the canvas unmounts and never runs again.
 *
 * Hand-rolled on a <canvas> rather than pulled in as a dependency — two rAF
 * bursts of palette-colored rectangles with gravity, drag and spin are ~80
 * lines, and the pieces stay in Donna's own colors (the score-term palette +
 * the two route colors) instead of a library's rainbow. Pops from the win
 * banner when it's on screen, from the top center when the narrow ribbon has
 * hidden it. Honors prefers-reduced-motion by not running at all.
 */

const COLORS = [...Object.values(TERM_COLORS), FLOW_DIRECT, FLOW_STORE];
const GRAVITY = 0.22;   // px/frame² — slow enough to flutter, fast enough to clear
const DRAG = 0.988;
const FADE_MS = 500;    // opacity ramp at the end of a piece's life
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

    const dpr = window.devicePixelRatio || 1;
    const size = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    size();
    window.addEventListener('resize', size);

    // Pop from under the banner; the banner may be display:none on a narrow
    // ribbon (or a beat away from mounting), so fall back to the top center.
    const originOf = (): [number, number] => {
      const r = document.querySelector('.win-banner')?.getBoundingClientRect();
      if (r && r.width > 0) return [r.left + r.width / 2, r.bottom];
      return [window.innerWidth / 2, 10];
    };

    const pieces: Piece[] = [];
    const burst = (n: number) => {
      const [ox, oy] = originOf();
      const now = performance.now();
      for (let i = 0; i < n; i++) {
        const angle = (-90 + (Math.random() - 0.5) * 130) * (Math.PI / 180);
        const speed = 5 + Math.random() * 9;
        pieces.push({
          x: ox, y: oy,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          w: 5 + Math.random() * 4, h: 8 + Math.random() * 6,
          rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
          color: COLORS[i % COLORS.length],
          born: now, life: 2000 + Math.random() * 900,
        });
      }
    };

    let raf = 0;
    let secondFired = false;
    const t2 = window.setTimeout(() => { burst(110); secondFired = true; }, SECOND_POP_MS);

    const tick = () => {
      const now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = pieces.length - 1; i >= 0; i--) {
        const p = pieces[i];
        const age = now - p.born;
        if (age > p.life || p.y > window.innerHeight + 30) { pieces.splice(i, 1); continue; }
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

    burst(130);
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t2);
      window.removeEventListener('resize', size);
    };
  }, []);

  if (done) return null;
  return <canvas ref={ref} className="confetti" aria-hidden="true" />;
}
