import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { openContractCall } from "@stacks/connect";
import { updateGameXP } from "../services/firebaseService";
import { principalCV, uintCV, contractPrincipalCV } from "@stacks/transactions";
import { STACKS_MAINNET } from "@stacks/network";

const SPRITES = {
  player: "/sprites/player-jet.png",
  enemyWhite: "/sprites/enemy-jet-white.png",
  enemyRed: "/sprites/enemy-jet-red.png",
  enemyHeavy: "/sprites/enemy-jet-heavy.png",
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
interface PickupEntity {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "exp" | "cultos" | "hostile";
  variant: "white" | "red" | "heavy";
  speedX: number;
  speedY: number;
  phase: number;
  scale: number;
  hp: number;
  maxHp: number;
  isHoming?: boolean;
}
interface Bullet { x: number; y: number; w: number; h: number; speed: number; }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; r: number; color: string; }
interface FloatText { x: number; y: number; text: string; color: string; size: number; life: number; maxLife: number; vy: number; }

interface RunResult { exp: number; cultos: number; wave: number; combo: number; }
interface ExitConfirmProps {
  currentExp: number;
  currentCultos: number;
  onCancel: () => void;
  onConfirm: () => void; // leads to claim/discard choice
}

const GAME_DURATION = 75; // fixed 75 seconds

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CANVAS GAME
// ═══════════════════════════════════════════════════════════════════════════════
function useGameEngine(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  active: boolean,
  onGameOver: (result: RunResult) => void,
) {
  const stateRef = useRef<any>({ paused: false });

  useEffect(() => {
    if (!active) return;
    // Reset paused whenever engine (re)starts
    if (stateRef.current) stateRef.current.paused = false;
    const canvasOrNull = canvasRef.current;
    if (!canvasOrNull) return;
    const canvas: HTMLCanvasElement = canvasOrNull;
    const ctxOrNull = canvas.getContext("2d");
    if (!ctxOrNull) return;
    const ctx: CanvasRenderingContext2D = ctxOrNull;

    // ── load sprites ──
    const playerImg = new Image();
    const whiteImg = new Image();
    const redImg = new Image();
    const heavyImg = new Image();
    playerImg.src = SPRITES.player;
    whiteImg.src = SPRITES.enemyWhite;
    redImg.src = SPRITES.enemyRed;
    heavyImg.src = SPRITES.enemyHeavy;

    function resize() {
      const wrapper = canvas.parentElement;
      const maxWidth = Math.min(wrapper ? wrapper.clientWidth : 500, 500);
      const w = maxWidth;
      const h = w * (16 / 9);
      canvas.width = w;
      canvas.height = h;
    }
    resize();
    window.addEventListener("resize", resize);

    const rand = (min: number, max: number) => Math.random() * (max - min) + min;
    const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));

    const player = { x: canvas.width / 2, y: canvas.height - 80, speed: 6.5, w: 46, h: 46 };
    let bullets: Bullet[] = [];
    let entities: PickupEntity[] = [];
    let particles: Particle[] = [];
    let floatTexts: FloatText[] = [];
    let stars: { x: number; y: number; r: number; a: number; speed: number }[] = [];
    let entityId = 0;

    // Health is now an "energy bar" — starts full, regens slowly, never hits 0 to end game
    let exp = 0, cultos = 0, health = 100, combo = 0, comboTimer = 0, wave = 1, score = 0;
    let gameActive = true;
    let elapsed = 0;
    let timeRemaining = GAME_DURATION;
    let spawnTimer = 0;
    let spawnInterval = 1.4;
    let lastTime = 0;
    let bulletInterval = 0;
    let bulletRate = 0.15;
    let shakeMag = 0;
    let invulnTimer = 0;

    // Heavy bandit spawn tracking — 3 spawns across 75s
    let heavySpawnCount = 0;
    // Spawn at ~20s, ~45s, ~65s
    const HEAVY_SPAWN_TIMES = [20, 45, 65];
    let heavySpawnIndex = 0;

    let isDragging = false;
    let dragX = 0;
    let keys: Record<string, boolean> = {};

    function difficultyTier() {
      return Math.min(10, 1 + Math.floor(elapsed / 12));
    }

    function addFloatText(x: number, y: number, text: string, color: string, size = 20) {
      floatTexts.push({ x, y, text, color, size, life: 1.0, maxLife: 1.0, vy: -1.6 });
    }

    function addParticles(x: number, y: number, color: string, count = 10) {
      for (let i = 0; i < count; i++) {
        particles.push({ x, y, vx: rand(-3, 3), vy: rand(-4, 1), life: rand(20, 50), maxLife: 50, r: rand(2, 5), color });
      }
    }

    function triggerShake(mag: number) {
      shakeMag = Math.max(shakeMag, mag);
    }

    function spawnHeavyBandit() {
      if (!gameActive) return;
      const tier = difficultyTier();
      const x = rand(60, canvas.width - 60);
      const y = -60;
      const hp = 12 + Math.floor(tier * 1.5); // Very high HP — needs many shots
      entities.push({
        id: entityId++,
        x, y,
        w: 58, h: 58,
        kind: "hostile",
        variant: "heavy",
        speedX: rand(-0.2, 0.2),
        speedY: rand(1.2, 1.6) + tier * 0.04, // faster than before
        phase: rand(0, Math.PI * 2),
        scale: 1.4,
        hp, maxHp: hp,
        isHoming: true,
      });
      addFloatText(canvas.width / 2, canvas.height / 3, "⚠ HEAVY BANDIT!", "#ff2222", 22);
    }

    function spawnWave() {
      if (!gameActive) return;
      const tier = difficultyTier();
      const count = 3 + Math.min(2, Math.floor(tier / 3));
      const spacing = canvas.width / (count + 1);
      const hostileChance = Math.min(0.5, 0.2 + tier * 0.035);

      for (let i = 0; i < count; i++) {
        const x = spacing * (i + 1) + rand(-16, 16);
        const y = -40 + rand(-15, 5);
        const roll = Math.random();
        let kind: PickupEntity["kind"];
        let variant: PickupEntity["variant"] = "white";

        if (roll < hostileChance) {
          kind = "hostile";
          // No heavy spawns from normal wave — only from timed heavy spawns
          variant = Math.random() < 0.5 ? "red" : "white";
        } else if (roll < hostileChance + 0.45) {
          kind = "exp";
          variant = "white";
        } else {
          kind = "cultos";
          variant = "red";
        }
        const hp = kind === "hostile" ? 2 + Math.floor(tier / 3) : 1;
        entities.push({
          id: entityId++,
          x, y,
          w: 38, h: 38,
          kind, variant,
          speedX: rand(-0.7, 0.7),
          speedY: rand(1.0, 1.5) + tier * 0.055,
          phase: rand(0, Math.PI * 2),
          scale: kind === "hostile" ? 1.0 : 0.82,
          hp, maxHp: hp,
        });
      }
    }

    function spawnBullet() {
      if (!gameActive) return;
      bullets.push({ x: player.x - 9, y: player.y - 26, w: 4, h: 13, speed: 12 });
      bullets.push({ x: player.x + 9, y: player.y - 26, w: 4, h: 13, speed: 12 });
    }

    function initStars() {
      stars = [];
      for (let i = 0; i < 110; i++) {
        stars.push({ x: rand(0, canvas.width), y: rand(0, canvas.height), r: rand(0.5, 2), a: rand(0.3, 1), speed: rand(0.3, 1.1) });
      }
    }
    initStars();

    function rectCollide(r1: any, r2: any) {
      return !(r2.x > r1.x + r1.w || r2.x + r2.w < r1.x || r2.y > r1.y + r1.h || r2.y + r2.h < r1.y);
    }

    function damagePlayer(amount: number) {
      if (invulnTimer > 0) return;
      health = Math.max(5, health - amount); // never drops below 5 — energy bar
      invulnTimer = 0.4;
      combo = 0;
      addFloatText(player.x, player.y - 40, `-${amount}`, "#ff4444", 22);
      addParticles(player.x, player.y, "#ff3333", 18);
      triggerShake(8);
    }

    function onDragStartFn(e: MouseEvent | TouchEvent) {
      e.preventDefault();
      isDragging = true;
      dragX = getX(e);
    }
    function onDragMoveFn(e: MouseEvent | TouchEvent) {
      e.preventDefault();
      if (!isDragging) return;
      dragX = getX(e);
    }
    function onDragEndFn(e: Event) { e.preventDefault(); isDragging = false; }
    function getX(e: any) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      let clientX;
      if (e.touches && e.touches[0]) clientX = e.touches[0].clientX;
      else clientX = e.clientX;
      return (clientX - rect.left) * scaleX;
    }
    function onKeyDown(e: KeyboardEvent) { keys[e.key] = true; }
    function onKeyUp(e: KeyboardEvent) { keys[e.key] = false; }

    canvas.addEventListener("mousedown", onDragStartFn as any);
    canvas.addEventListener("mousemove", onDragMoveFn as any);
    canvas.addEventListener("mouseup", onDragEndFn);
    canvas.addEventListener("mouseleave", onDragEndFn);
    canvas.addEventListener("touchstart", onDragStartFn as any, { passive: false });
    canvas.addEventListener("touchmove", onDragMoveFn as any, { passive: false });
    canvas.addEventListener("touchend", onDragEndFn, { passive: false });
    canvas.addEventListener("touchcancel", onDragEndFn, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function drawSprite(img: HTMLImageElement, x: number, y: number, h: number, glow?: string) {
      if (!img.complete || img.naturalWidth === 0) return;
      const aspect = img.naturalWidth / img.naturalHeight;
      const w = h * aspect;
      ctx.save();
      if (glow) {
        ctx.shadowColor = glow;
        ctx.shadowBlur = 18;
      }
      ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
      ctx.restore();
    }

    let rafId = 0;
    function loop(timestamp: number) {
      // ── Pause support: skip logic but keep RAF alive so resume is instant ──
      if (stateRef.current?.paused) {
        lastTime = timestamp; // prevent dt spike on resume
        rafId = requestAnimationFrame(loop);
        return;
      }

      const dt = lastTime ? Math.min(0.05, (timestamp - lastTime) / 1000) : 0.016;
      lastTime = timestamp;

      if (gameActive) {
        elapsed += dt;
        timeRemaining = Math.max(0, GAME_DURATION - elapsed);
        wave = difficultyTier();
        spawnInterval = Math.max(0.6, 1.4 - wave * 0.065);
        bulletRate = Math.max(0.09, 0.15 - wave * 0.005);

        // ── Timed Heavy Bandit spawns (3x over 75s) ──
        if (heavySpawnIndex < HEAVY_SPAWN_TIMES.length && elapsed >= HEAVY_SPAWN_TIMES[heavySpawnIndex]) {
          spawnHeavyBandit();
          heavySpawnCount++;
          heavySpawnIndex++;
        }

        // ── Game ends at 75s ──
        if (timeRemaining <= 0) {
          gameActive = false;
          onGameOver({ exp, cultos, wave, combo: Math.max(combo, 0) });
          return;
        }

        // ── Health slow regen (energy bar) ──
        health = Math.min(100, health + 1.8 * dt);

        spawnTimer += dt;
        if (spawnTimer >= spawnInterval) { spawnTimer = 0; spawnWave(); }

        bulletInterval += dt;
        if (bulletInterval >= bulletRate) { bulletInterval = 0; spawnBullet(); }

        if (invulnTimer > 0) invulnTimer -= dt;
        if (comboTimer > 0) { comboTimer -= dt; if (comboTimer <= 0) combo = 0; }
        if (shakeMag > 0) shakeMag *= 0.85;
        if (shakeMag < 0.2) shakeMag = 0;

        if (keys["ArrowLeft"] || keys["a"] || keys["A"]) player.x -= player.speed;
        if (keys["ArrowRight"] || keys["d"] || keys["D"]) player.x += player.speed;
        player.x = Math.max(26, Math.min(canvas.width - 26, player.x));

        if (isDragging) {
          const diff = dragX - player.x;
          if (Math.abs(diff) > 1) player.x += Math.sign(diff) * Math.min(Math.abs(diff), player.speed * 1.4);
        }

        // ── Homing logic for Heavy Bandits ──
        for (const e of entities) {
          if (e.isHoming && e.kind === "hostile") {
            const dx = player.x - e.x;
            e.speedX += Math.sign(dx) * 0.06; // slow homing pull
            e.speedX = Math.max(-2.5, Math.min(2.5, e.speedX)); // cap horizontal speed
          }
        }

        // ── bullets vs entities ──
        for (let i = bullets.length - 1; i >= 0; i--) {
          const b = bullets[i];
          b.y -= b.speed;
          if (b.y < -20) { bullets.splice(i, 1); continue; }
          let hit = false;
          for (let j = entities.length - 1; j >= 0; j--) {
            const e = entities[j];
            if (rectCollide({ x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h }, { x: e.x - e.w / 2, y: e.y - e.h / 2, w: e.w, h: e.h })) {
              e.hp -= 1;
              hit = true;
              if (e.hp <= 0) {
                if (e.kind === "exp") {
                  combo += 1;
                  comboTimer = 2.2;
                  const mult = 1 + Math.min(2, Math.floor(combo / 5) * 0.5);
                  const gain = Math.round(randInt(3, 5) * mult);
                  exp += gain;
                  score += gain;
                  addFloatText(e.x, e.y - 10, `+${gain} XP`, "#4ade80", 20);
                  addParticles(e.x, e.y, "#d946ef", 12);
                } else if (e.kind === "cultos") {
                  combo += 1;
                  comboTimer = 2.2;
                  const mult = 1 + Math.min(2, Math.floor(combo / 5) * 0.5);
                  const gain = Math.round(randInt(1, 3) * mult);
                  cultos += gain;
                  score += gain * 2;
                  addFloatText(e.x, e.y - 10, `+${gain} CULT`, "#fbbf24", 20);
                  addParticles(e.x, e.y, "#3b82f6", 15);
                } else {
                  // HOSTILE KILLED
                  const isHeavyKill = e.variant === "heavy";
                  if (isHeavyKill) {
                    // Heavy bandit: small reward on kill (main threat was surviving it)
                    const gain = 6 + wave;
                    exp += gain;
                    addFloatText(e.x, e.y - 10, `+${gain} XP`, "#f97316", 24);
                    addParticles(e.x, e.y, "#ff5500", 40);
                    triggerShake(10);
                  } else {
                    // Normal hostile: small reward
                    const gain = 3 + wave;
                    exp += gain;
                    score += gain;
                    addFloatText(e.x, e.y - 10, `+${gain} XP`, "#f97316", 20);
                    addParticles(e.x, e.y, "#ff5500", 20);
                    triggerShake(4);
                  }
                }
                entities.splice(j, 1);
              } else {
                // Heavy bandit DRAINS HEALTH when shot (still alive)
                if (e.kind === "hostile" && e.variant === "heavy") {
                  const drain = 6 + Math.floor(wave * 0.8);
                  damagePlayer(drain);
                  addFloatText(e.x, e.y + 20, "⚡ DRAINING!", "#ff2222", 14);
                } else {
                  addParticles(b.x, b.y, "#ffffff", 4);
                }
              }
              break;
            }
          }
          if (hit) bullets.splice(i, 1);
        }

        // ── move + collide entities with player ──
        for (let k = entities.length - 1; k >= 0; k--) {
          const e = entities[k];
          e.phase += 0.03;
          e.x += e.speedX + Math.sin(e.phase) * (e.isHoming ? 0.2 : 0.5);
          e.y += e.speedY;
          if (e.x < 20) e.x = 20;
          if (e.x > canvas.width - 20) e.x = canvas.width - 20;

          if (rectCollide({ x: e.x - e.w / 2, y: e.y - e.h / 2, w: e.w, h: e.h }, { x: player.x - player.w / 2, y: player.y - player.h / 2, w: player.w, h: player.h })) {
            if (e.kind === "hostile") {
              const dmg = e.variant === "heavy" ? 35 + wave * 2 : 14 + wave;
              damagePlayer(dmg);
              entities.splice(k, 1);
              continue;
            } else if (e.kind === "exp") {
              const gain = randInt(2, 3);
              exp += gain;
              addFloatText(e.x, e.y - 10, `+${gain}`, "#4ade80", 18);
              addParticles(e.x, e.y, "#d946ef", 10);
              entities.splice(k, 1);
              continue;
            } else if (e.kind === "cultos") {
              const gain = randInt(1, 2);
              cultos += gain;
              addFloatText(e.x, e.y - 10, `+${gain}`, "#fbbf24", 18);
              addParticles(e.x, e.y, "#3b82f6", 10);
              entities.splice(k, 1);
              continue;
            }
          }
        }
        entities = entities.filter(e => e.y < canvas.height + 60);

        for (let i = particles.length - 1; i >= 0; i--) {
          const p = particles[i];
          p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.life--;
          if (p.life <= 0) particles.splice(i, 1);
        }
        for (let i = floatTexts.length - 1; i >= 0; i--) {
          const ft = floatTexts[i];
          ft.y += ft.vy; ft.life -= dt;
          if (ft.life <= 0) floatTexts.splice(i, 1);
        }
        for (const s of stars) {
          s.y += s.speed * 0.6;
          if (s.y > canvas.height) { s.y = 0; s.x = rand(0, canvas.width); }
        }

        // sync external state for HUD
        stateRef.current = { exp, cultos, health, combo, wave, score, timeRemaining };

        // Check external exit request
        if (stateRef.current?.exitRequested) {
          gameActive = false;
          onGameOver({ exp, cultos, wave, combo: Math.max(combo, 0) });
          return;
        }
      }

      // ── draw ──
      ctx.save();
      if (shakeMag > 0) {
        ctx.translate(rand(-shakeMag, shakeMag), rand(-shakeMag, shakeMag));
      }
      ctx.clearRect(-20, -20, canvas.width + 40, canvas.height + 40);
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, "#1a0a2e");
      grad.addColorStop(0.5, "#0d001a");
      grad.addColorStop(1, "#05000a");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (const s of stars) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,180,255,${s.a})`;
        ctx.fill();
      }

      for (const p of particles) {
        const alpha = p.life / p.maxLife;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * alpha, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      for (const e of entities) {
        const img = e.variant === "heavy" ? heavyImg : e.variant === "red" ? redImg : whiteImg;
        const h = 42 * e.scale;
        if (e.kind === "hostile") {
          const isHeavy = e.variant === "heavy";
          drawSprite(img, e.x, e.y, h, isHeavy ? "#ff0033" : "#ff3344");
          if (e.maxHp > 1) {
            const barW = isHeavy ? 52 : 30;
            ctx.fillStyle = "rgba(0,0,0,0.5)";
            ctx.fillRect(e.x - barW / 2, e.y + h / 2 + 4, barW, isHeavy ? 6 : 4);
            ctx.fillStyle = isHeavy ? "#ff2222" : "#ff5566";
            ctx.fillRect(e.x - barW / 2, e.y + h / 2 + 4, barW * (e.hp / e.maxHp), isHeavy ? 6 : 4);
          }
        } else {
          drawSprite(img, e.x, e.y, h, e.kind === "exp" ? "#d946ef" : "#3b82f6");
        }
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        if (e.kind === "exp") ctx.fillText("EXP", e.x, e.y + h / 2 + (e.maxHp > 1 ? 16 : 12));
        else if (e.kind === "cultos") ctx.fillText("$CULT", e.x, e.y + h / 2 + 12);
        else if (e.variant === "heavy") {
          ctx.fillStyle = "rgba(255,80,80,0.9)";
          ctx.font = "bold 9px monospace";
          ctx.fillText("☣ HEAVY BANDIT", e.x, e.y + h / 2 + 20);
          // Warning: draining indicator
          ctx.fillStyle = "rgba(255,160,0,0.8)";
          ctx.font = "8px monospace";
          ctx.fillText("⚡ DRAINS ON HIT", e.x, e.y + h / 2 + 30);
        }
        else ctx.fillText("⚠ HOSTILE", e.x, e.y + h / 2 + (e.maxHp > 1 ? 16 : 12));
      }

      for (const b of bullets) {
        const g = ctx.createLinearGradient(b.x, b.y - 6, b.x, b.y + 6);
        g.addColorStop(0, "#fcd34d");
        g.addColorStop(1, "#f59e0b");
        ctx.shadowColor = "#fbbf24";
        ctx.shadowBlur = 10;
        ctx.fillStyle = g;
        ctx.fillRect(b.x - 2, b.y - 6, 4, 12);
        ctx.shadowBlur = 0;
      }

      ctx.globalAlpha = invulnTimer > 0 ? (Math.floor(elapsed * 20) % 2 === 0 ? 0.4 : 1) : 1;
      drawSprite(playerImg, player.x, player.y, 50, "#a78bfa");
      ctx.globalAlpha = 1;

      for (const ft of floatTexts) {
        const alpha = Math.min(1, (ft.life / ft.maxLife) * 2);
        ctx.globalAlpha = alpha;
        ctx.font = `bold ${ft.size}px monospace`;
        ctx.textAlign = "center";
        ctx.shadowColor = "rgba(0,0,0,0.8)";
        ctx.shadowBlur = 6;
        ctx.fillStyle = ft.color;
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      if (gameActive) {
        rafId = requestAnimationFrame(loop);
      }
    }

    spawnWave();
    rafId = requestAnimationFrame(loop);

    return () => {
      gameActive = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("mousedown", onDragStartFn as any);
      canvas.removeEventListener("mousemove", onDragMoveFn as any);
      canvas.removeEventListener("mouseup", onDragEndFn);
      canvas.removeEventListener("mouseleave", onDragEndFn);
      canvas.removeEventListener("touchstart", onDragStartFn as any);
      canvas.removeEventListener("touchmove", onDragMoveFn as any);
      canvas.removeEventListener("touchend", onDragEndFn);
      canvas.removeEventListener("touchcancel", onDragEndFn);
    };
  }, [active]);

  return stateRef;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HUD OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════
function GameHUD({ stateRef, onExitRequest }: { stateRef: React.RefObject<any>; onExitRequest: () => void }) {
  const [hud, setHud] = useState({ exp: 0, cultos: 0, health: 100, combo: 0, wave: 1, timeRemaining: GAME_DURATION });
  useEffect(() => {
    const id = setInterval(() => {
      if (stateRef.current) setHud({ ...stateRef.current });
    }, 100);
    return () => clearInterval(id);
  }, [stateRef]);

  const healthPct = Math.max(0, hud.health);
  // Energy bar colors: purple/blue theme (not "health" red/green)
  const energyColor = healthPct > 60 ? "#a855f7" : healthPct > 30 ? "#f59e0b" : "#ef4444";
  const timeLeft = Math.ceil(hud.timeRemaining);
  const timePct = (hud.timeRemaining / GAME_DURATION) * 100;
  const timeColor = timeLeft > 30 ? "#4ade80" : timeLeft > 10 ? "#f59e0b" : "#ef4444";

  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "10px 14px", zIndex: 5, pointerEvents: "none" }}>
      {/* Row 1: stats + wave + EXIT */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 900, fontFamily: "monospace", color: "#4ade80", textShadow: "0 0 8px #4ade8080" }}>⚡ {hud.exp}</span>
          <span style={{ fontSize: 13, fontWeight: 900, fontFamily: "monospace", color: "#fbbf24", textShadow: "0 0 8px #fbbf2480" }}>🪙 {hud.cultos}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {hud.combo >= 5 && (
            <span style={{ fontSize: 11, fontWeight: 900, fontFamily: "monospace", color: "#f97316", textShadow: "0 0 10px #f9731680" }}>
              COMBO x{1 + Math.min(2, Math.floor(hud.combo / 5) * 0.5)}
            </span>
          )}
          <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "monospace", color: "rgba(255,255,255,0.4)" }}>WAVE {hud.wave}</span>
          {/* EXIT button — pointer events re-enabled just for this button */}
          <button
            onClick={onExitRequest}
            style={{
              pointerEvents: "all",
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.35)",
              borderRadius: 6,
              padding: "3px 8px",
              color: "#ef4444",
              fontSize: 9,
              fontFamily: "monospace",
              fontWeight: 900,
              cursor: "pointer",
              letterSpacing: 1,
            }}
          >✕ EXIT</button>
        </div>
      </div>

      {/* Energy bar */}
      <div style={{ width: "100%", height: 14, background: "rgba(0,0,0,0.5)", borderRadius: 7, overflow: "hidden", border: "1px solid rgba(255,255,255,0.08)", marginBottom: 4 }}>
        <div style={{ height: "100%", width: `${healthPct}%`, background: energyColor, transition: "width 0.15s, background 0.3s", boxShadow: `0 0 10px ${energyColor}80` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(255,255,255,0.3)" }}>⚡ ENERGY</span>
        {/* Countdown timer */}
        <span style={{ fontSize: 14, fontWeight: 900, fontFamily: "monospace", color: timeColor, textShadow: `0 0 10px ${timeColor}80` }}>
          {timeLeft}s
        </span>
      </div>

      {/* Timer bar */}
      <div style={{ width: "100%", height: 4, background: "rgba(0,0,0,0.4)", borderRadius: 2, overflow: "hidden", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ height: "100%", width: `${timePct}%`, background: timeColor, transition: "width 0.1s linear", boxShadow: `0 0 6px ${timeColor}60` }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXIT CONFIRM OVERLAY (shown while in-game)
// ═══════════════════════════════════════════════════════════════════════════════
function ExitConfirmOverlay({
  currentExp,
  currentCultos,
  onCancel,
  onConfirm,
}: ExitConfirmProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.82)", backdropFilter: "blur(8px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 60, borderRadius: 16 }}
    >
      <motion.div
        initial={{ scale: 0.88, y: 12 }} animate={{ scale: 1, y: 0 }}
        style={{ background: "linear-gradient(145deg, #1f0d3a, #2a1450)", padding: "28px 24px", borderRadius: 22, border: "1px solid rgba(239,68,68,0.4)", boxShadow: "0 0 50px rgba(239,68,68,0.2)", textAlign: "center", color: "white", maxWidth: 320, width: "86%" }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontSize: 17, fontWeight: 900, color: "#ef4444", fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>EXIT MISSION?</div>
        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginBottom: 18, lineHeight: 1.6 }}>
          Are you sure you want to exit?<br />You can still claim what you earned so far.
        </div>

        {/* Current earnings */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 14px", background: "rgba(0,0,0,0.3)", borderRadius: 9, border: "1px solid rgba(74,222,128,0.2)" }}>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.45)" }}>⚡ DEVOTION XP (current)</span>
            <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 900, color: "#4ade80" }}>+{currentExp}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 14px", background: "rgba(0,0,0,0.3)", borderRadius: 9, border: "1px solid rgba(251,191,36,0.2)" }}>
            <span style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(255,255,255,0.45)" }}>🪙 $CultOS (current)</span>
            <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 900, color: "#fbbf24" }}>+{currentCultos}</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onCancel}
            style={{ flex: 1, background: "rgba(74,222,128,0.1)", border: "1px solid rgba(74,222,128,0.3)", borderRadius: 12, padding: "12px 0", color: "#4ade80", fontSize: 12, fontFamily: "monospace", fontWeight: 900, cursor: "pointer", letterSpacing: 1 }}
          >▶ CONTINUE</button>
          <button
            onClick={onConfirm}
            style={{ flex: 1, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", borderRadius: 12, padding: "12px 0", color: "#ef4444", fontSize: 12, fontFamily: "monospace", fontWeight: 900, cursor: "pointer", letterSpacing: 1 }}
          >✕ EXIT</button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAME OVER / CLAIM MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function ClaimModal({
  result,
  onClaim,
  onDiscard,
  onPlayAgain,
  claiming,
  claimed,
  walletAddress,
  onConnectStacks,
  isConnecting,
}: {
  result: RunResult;
  onClaim: () => void;
  onDiscard: () => void;
  onPlayAgain: () => void;
  claiming: boolean;
  claimed: boolean;
  walletAddress: string | null;
  onConnectStacks: () => void;
  isConnecting: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 50, borderRadius: 16 }}
    >
      <motion.div
        initial={{ scale: 0.9, y: 10 }} animate={{ scale: 1, y: 0 }}
        style={{ background: "linear-gradient(145deg, #1f0d3a, #2a1450)", padding: "28px 28px", borderRadius: 24, border: "1px solid #7c3aed", boxShadow: "0 0 60px rgba(124,58,237,0.4)", textAlign: "center", color: "white", maxWidth: 340, width: "88%" }}
      >
        <div style={{ fontSize: 26, marginBottom: 6 }}>🏁</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: "#c084fc", fontFamily: "monospace", marginBottom: 4 }}>MISSION COMPLETE</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginBottom: 18 }}>75 SECONDS SURVIVED</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "rgba(0,0,0,0.25)", borderRadius: 10, border: "1px solid rgba(74,222,128,0.2)" }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>⚡ DEVOTION XP</span>
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 900, color: "#4ade80" }}>+{result.exp}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", background: "rgba(0,0,0,0.25)", borderRadius: 10, border: "1px solid rgba(251,191,36,0.2)" }}>
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>🪙 $CultOS</span>
            <span style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 900, color: "#fbbf24" }}>+{result.cultos}</span>
          </div>
        </div>

        {!claimed ? (
          <>
            {!walletAddress ? (
              <>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginBottom: 10, lineHeight: 1.6 }}>
                  Connect Stacks Wallet to claim your rewards on-chain
                </div>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.96 }}
                  onClick={onConnectStacks}
                  disabled={isConnecting}
                  style={{ width: "100%", background: isConnecting ? "rgba(124,58,237,0.3)" : "linear-gradient(135deg, #7c3aed, #a855f7)", border: "none", color: "white", fontSize: 14, fontWeight: 900, fontFamily: "monospace", padding: "13px 0", borderRadius: 14, cursor: isConnecting ? "wait" : "pointer", boxShadow: isConnecting ? "none" : "0 0 20px rgba(124,58,237,0.5)", letterSpacing: 1, marginBottom: 8 }}
                >
                  {isConnecting ? "CONNECTING..." : "🔗 CONNECT STACKS"}
                </motion.button>
                <button
                  onClick={onDiscard}
                  style={{ width: "100%", background: "transparent", border: "1px solid rgba(239,68,68,0.25)", color: "rgba(239,68,68,0.6)", fontSize: 11, fontFamily: "monospace", fontWeight: 700, padding: "10px 0", borderRadius: 10, cursor: "pointer", marginBottom: 8 }}
                >
                  DISCARD & RETRY
                </button>
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.96 }}
                  onClick={onClaim}
                  disabled={claiming}
                  style={{ width: "100%", background: claiming ? "rgba(124,58,237,0.3)" : "linear-gradient(135deg, #7c3aed, #a855f7)", border: "none", color: "white", fontSize: 15, fontWeight: 900, fontFamily: "monospace", padding: "14px 0", borderRadius: 14, cursor: claiming ? "wait" : "pointer", boxShadow: claiming ? "none" : "0 0 20px rgba(124,58,237,0.5)", letterSpacing: 1 }}
                >
                  {claiming ? "SIGNING TRANSACTION..." : "🚀 CLAIM REWARDS"}
                </motion.button>
                <button
                  onClick={onDiscard}
                  style={{ width: "100%", background: "transparent", border: "1px solid rgba(239,68,68,0.25)", color: "rgba(239,68,68,0.6)", fontSize: 11, fontFamily: "monospace", fontWeight: 700, padding: "10px 0", borderRadius: 10, cursor: "pointer" }}
                >
                  DISCARD & RETRY
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ padding: "14px 0", color: "#4ade80", fontFamily: "monospace", fontWeight: 900, fontSize: 14 }}>
              ✅ CLAIMED TO STACKS WALLET
            </div>
            <button
              onClick={onPlayAgain}
              style={{ marginTop: 8, width: "100%", background: "transparent", border: "1px solid rgba(168,85,247,0.3)", color: "rgba(255,255,255,0.6)", fontSize: 11, fontFamily: "monospace", fontWeight: 700, padding: "10px 0", borderRadius: 10, cursor: "pointer" }}
            >
              PLAY AGAIN
            </button>
          </>
        )}

        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "monospace", marginTop: 14 }}>
          * Rewards sent via SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-game-rewards-v2
        </div>
      </motion.div>
    </motion.div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN EXPORTED PANEL
// ═══════════════════════════════════════════════════════════════════════════════
export default function MissionGame({
  walletAddress,
  onConnectWallet,
  isConnecting,
  onClaimRewards,
  isMobile,
  onSetPlaying,
}: {
  walletAddress: string | null;
  onConnectWallet: () => void;
  isConnecting: boolean;
  onClaimRewards: (exp: number, cultos: number) => void;
  isMobile?: boolean;
  onSetPlaying?: (playing: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "playing" | "exitConfirm" | "ended">("idle");
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  // Live HUD stats for exit confirm display
  const [liveStats, setLiveStats] = useState({ exp: 0, cultos: 0 });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Engine stays alive for both "playing" and "exitConfirm" — paused via stateRef flag
  const isEngineActive = phase === "playing" || phase === "exitConfirm";
  const stateRef = useGameEngine(canvasRef, isEngineActive, (result) => {
    setLastResult(result);
    setPhase("ended");
    onSetPlaying?.(false);
  });

  // Sync pause flag into engine stateRef when phase changes
  useEffect(() => {
    if (stateRef.current) {
      stateRef.current.paused = phase === "exitConfirm";
    }
  }, [phase, stateRef]);

  // Poll live stats while engine is active
  useEffect(() => {
    if (!isEngineActive) return;
    const id = setInterval(() => {
      if (stateRef.current) {
        setLiveStats({ exp: stateRef.current.exp, cultos: stateRef.current.cultos });
      }
    }, 200);
    return () => clearInterval(id);
  }, [isEngineActive, stateRef]);

  const startGame = useCallback(() => {
    setClaimed(false);
    setLastResult(null);
    setLiveStats({ exp: 0, cultos: 0 });
    setPhase("playing");
    onSetPlaying?.(true);
  }, [onSetPlaying]);

  const handleExitRequest = useCallback(() => {
    // Pause engine immediately
    if (stateRef.current) stateRef.current.paused = true;
    setPhase("exitConfirm");
  }, [stateRef]);

  const handleExitCancel = useCallback(() => {
    // Unpause engine
    if (stateRef.current) stateRef.current.paused = false;
    setPhase("playing");
  }, [stateRef]);

  const handleExitConfirm = useCallback(() => {
    const result = stateRef.current
      ? { exp: stateRef.current.exp, cultos: stateRef.current.cultos, wave: stateRef.current.wave, combo: stateRef.current.combo ?? 0 }
      : { exp: liveStats.exp, cultos: liveStats.cultos, wave: 1, combo: 0 };
    // Signal engine to stop fully
    if (stateRef.current) stateRef.current.exitRequested = true;
    setLastResult(result);
    setPhase("ended");
    onSetPlaying?.(false);
  }, [stateRef, liveStats, onSetPlaying]);

  const handleClaim = useCallback(async () => {
    if (!lastResult) return;
    setClaiming(true);

    // Contract v4 — treasury held by contract, Clarity 2
    const CONTRACT_ADDRESS = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
    const CONTRACT_NAME    = "cultos-game-rewards-v4";
    const TOKEN_ADDRESS    = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
    const TOKEN_NAME       = "CultOS";

    //  decimals = 6 → 1 token = 1_000_000 micro-units
    const cultosRaw = BigInt(lastResult.cultos) * BigInt(1_000_000);
    const xpRaw     = lastResult.exp;

    try {
      await openContractCall({
        network: STACKS_MAINNET,
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName: "claim-rewards",
        functionArgs: [
          contractPrincipalCV(TOKEN_ADDRESS, TOKEN_NAME),
          uintCV(xpRaw),
          uintCV(cultosRaw),
        ],
        postConditionMode: 1,
        onFinish: async (data: any) => {
          console.log("Claim txid:", data.txId);
          onClaimRewards(lastResult.exp, lastResult.cultos);
          // Sync game XP ke Firestore supaya masuk leaderboard
          if (walletAddress) {
            await updateGameXP(walletAddress, lastResult.exp);
          }
          setClaiming(false);
          setClaimed(true);
        },
        onCancel: () => {
          setClaiming(false);
        },
      });
    } catch (err) {
      console.error("Claim error:", err);
      setClaiming(false);
    }
  }, [lastResult, onClaimRewards]);

  const handleDiscard = useCallback(() => {
    setClaimed(false);
    setLastResult(null);
    setPhase("idle");
    onSetPlaying?.(false);
  }, [onSetPlaying]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}>
      {/* Hide description card while playing */}
      {phase === "idle" && (
        <div style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(12px)", border: "1px solid rgba(168,85,247,0.1)", borderRadius: 16, padding: isMobile ? 16 : 20, boxShadow: "0 0 20px rgba(168,85,247,0.05)" }}>
          <div style={{ fontSize: 11, fontFamily: "monospace", letterSpacing: 3, fontWeight: 700, color: "#A855F7", marginBottom: 6 }}>◈ SKY STRIKE: DEVOTION RUN ◈</div>
          <div style={{ fontSize: isMobile ? 18 : 22, fontWeight: 900, color: "white", fontFamily: "monospace", marginBottom: 8 }}>MISSION CHAMBER</div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", lineHeight: 1.5 }}>
            75 seconds. Pilot your interceptor, collect ⚡ EXP and 🪙 $CultOS shards. Beware ☣ Heavy Bandits — they're fast, homing, and <strong style={{color:"#ff6666"}}>drain your energy when shot</strong>. Dodge or destroy them with many hits. Connect Stacks after the run to claim rewards on-chain.
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", justifyContent: "center", position: "relative" }}>
        <div style={{ position: "relative", width: "100%", maxWidth: 500, borderRadius: 16, overflow: "hidden", background: "linear-gradient(145deg, #1a0a2e, #0d001a)", boxShadow: "0 0 40px rgba(120,40,200,0.25)", border: "1px solid rgba(168,85,247,0.15)" }}>

          {phase !== "idle" && (
            <div style={{ position: "relative", aspectRatio: "9/16" }}>
              <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%", touchAction: "none" }} />
              {phase === "playing" && <GameHUD stateRef={stateRef} onExitRequest={handleExitRequest} />}

              <AnimatePresence>
                {phase === "exitConfirm" && (
                  <ExitConfirmOverlay
                    currentExp={liveStats.exp}
                    currentCultos={liveStats.cultos}
                    onCancel={handleExitCancel}
                    onConfirm={handleExitConfirm}
                  />
                )}
              </AnimatePresence>

              <AnimatePresence>
                {phase === "ended" && lastResult && (
                  <ClaimModal
                    result={lastResult}
                    onClaim={handleClaim}
                    onDiscard={handleDiscard}
                    onPlayAgain={startGame}
                    claiming={claiming}
                    claimed={claimed}
                    walletAddress={walletAddress}
                    onConnectStacks={onConnectWallet}
                    isConnecting={isConnecting}
                  />
                )}
              </AnimatePresence>
            </div>
          )}

          {phase === "idle" && (
            <div style={{ aspectRatio: "9/16", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, gap: 18, textAlign: "center" }}>
              <div style={{ fontSize: 48 }}>🛩️</div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: 1 }}>READY FOR DEPLOYMENT</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", maxWidth: 280, lineHeight: 1.6 }}>
                Drag left/right or use arrow keys to steer. Auto-fires — focus on dodging.<br/>
                <span style={{ color: "rgba(255,100,100,0.7)" }}>⚠ Heavy Bandits drain your energy when shot — dodge or outgun them fast!</span>
              </div>

              {/* Always show Play button — no wallet needed to play */}
              <motion.button
                whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}
                onClick={startGame}
                style={{ background: "linear-gradient(135deg, #22C55E, #16A34A)", border: "none", borderRadius: 12, padding: "14px 40px", color: "white", fontWeight: 900, fontSize: 15, letterSpacing: 1, cursor: "pointer", fontFamily: "monospace", boxShadow: "0 0 20px rgba(34,197,94,0.4)" }}
              >
                ▶ PLAY GAME
              </motion.button>

              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", maxWidth: 260 }}>
                {walletAddress
                  ? `STACKS BOUND: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
                  : "Connect Stacks after the run to claim rewards on-chain"}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
