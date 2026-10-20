// Battle simulation shared by the browser client and (later) the game server.
// Nothing in here may touch the DOM, the canvas, the keyboard, timers or the
// network: it only receives a time step plus one command per human pilot, and
// mutates the run / battle objects it was given.
(root => {
  'use strict';
  const TAU = Math.PI * 2, ARENA_W = 1200, ARENA_H = 800;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const angleDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const quantize8 = angle => Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const IDLE = Object.freeze({ angle: null, move: false, fire: false, useItem: false });
  const DEG = Math.PI / 180, BARREL_GAP = 13;

  function createCore({ config: CFG, weapons: W, items: ITEMS, random = Math.random }) {
    // A weapon's numbers at a given level: the base entry with every level up to that one applied on top.
    const statCache = new Map();
    function weaponStats(type, level = 1) {
      const key = type + level;
      if (!statCache.has(key)) statCache.set(key, Object.assign({}, W[type], ...(W[type].levels || []).slice(0, level - 1)));
      return statCache.get(key);
    }

    // ---- run (state that survives across rounds) ----

    function createRun({ count, mode, teams, maxHp, difficulty, rounds, humans = 1 }) {
      const settings = { count, mode, teams, maxHp, difficulty };
      const infinite = rounds === 'infinite';
      const pilots = Array.from({ length: count }, (_, i) => ({
        id: i,
        name: i < humans ? (humans === 1 ? 'PLAYER' : `P${i + 1}`) : `CPU-${String(i).padStart(2, '0')}`,
        human: i < humans,
        team: mode === 'ffa' ? i : i % teams,
        money: 0, weapon: 'basic', weaponLevel: 1, item: null, itemCharges: 0,
        wins: 0, totalKills: 0, lossStreak: 0, aliveLast: true,
        personality: { near: .65 + random() * .55, retaliate: .3 + random() * .7, bounty: .15 + random() * .7, wander: random() * .25 }
      }));
      return { settings, round: 1, maxRounds: infinite ? Infinity : +rounds, infinite, pilots };
    }

    function advanceRound(run) {
      if (!run.infinite && run.round >= run.maxRounds) return false;
      run.round++;
      return true;
    }

    // What buying `key` would mean for this pilot right now, or null when it is not on sale to them.
    // kind: 'buy' a new weapon (back to Lv1), 'upgrade' the held one, or 'max' when it is already Lv3.
    function weaponOffer(run, p, key) {
      if (!own(W, key)) return null;
      const w = W[key];
      if (w.threeHpOnly && run.settings.maxHp !== 3) return null;
      if (key === p.weapon) return p.weaponLevel >= 3 ? { kind: 'max', price: 0, level: 3 } : { kind: 'upgrade', price: w.upgrade[p.weaponLevel - 1], level: p.weaponLevel + 1 };
      if (key === 'basic') return null; // only dying takes you back to the basic weapon
      return { kind: 'buy', price: w.price, level: 1 };
    }

    // kind: 'buy' a different item, 'refill' the held one (paying only for the missing charges), or 'full'.
    function itemOffer(p, key) {
      if (!own(ITEMS, key)) return null;
      const it = ITEMS[key];
      if (p.item !== key) return { kind: 'buy', price: it.price };
      const missing = it.charges - p.itemCharges;
      return missing <= 0 ? { kind: 'full', price: 0 } : { kind: 'refill', price: Math.ceil(it.price * missing / it.charges / 10) * 10 };
    }

    function buy(run, pilotId, type, key) {
      const p = run.pilots[pilotId];
      const offer = !p ? null : type === 'weapon' ? weaponOffer(run, p, key) : type === 'item' ? itemOffer(p, key) : null;
      if (!offer || offer.kind === 'max' || offer.kind === 'full' || p.money < offer.price) return false;
      if (type === 'weapon') { if (offer.kind === 'upgrade') p.weaponLevel++; else { p.weapon = key; p.weaponLevel = 1; } }
      else { p.item = key; p.itemCharges = ITEMS[key].charges; }
      p.money -= offer.price;
      return true;
    }

    function investedIn(p) { const w = W[p.weapon]; let total = w.price; for (let l = 1; l < p.weaponLevel; l++) total += w.upgrade[l - 1]; return total; }

    // AI shopping: switch to a weapon worth more than everything sunk into the current one, otherwise
    // upgrade what it holds, then refill or replace the item with what is left.
    function autoBuy(run) {
      run.pilots.filter(p => !p.human).forEach(p => {
        const worth = investedIn(p);
        const better = Object.keys(W).filter(k => { const o = weaponOffer(run, p, k); return o && o.kind === 'buy' && o.price > worth && o.price <= p.money; }).sort((a, b) => W[b].price - W[a].price);
        if (better[0]) buy(run, p.id, 'weapon', better[0]);
        else while (buy(run, p.id, 'weapon', p.weapon));
        if (p.item) buy(run, p.id, 'item', p.item);
        const heldItemPrice = p.item && p.itemCharges > 0 ? ITEMS[p.item].price : 0;
        const its = Object.entries(ITEMS).filter(([, v]) => v.price > heldItemPrice && v.price <= p.money).sort((a, b) => b[1].price - a[1].price);
        if (its[0]) buy(run, p.id, 'item', its[0][0]);
      });
    }

    // ---- battle (state of a single round) ----

    function spawnPositions(n) {
      const cx = 600, cy = 400, rx = 420, ry = 280;
      return Array.from({ length: n }, (_, i) => { const a = -Math.PI / 2 + i * TAU / n; return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry, a: a + Math.PI }; });
    }

    function startBattle(run) {
      const positions = spawnPositions(run.pilots.length);
      const battle = { settings: run.settings, crafts: [], bullets: [], mines: [], lasers: [], events: [], time: 0, timeLeft: CFG.arena.roundTime, started: false, ended: false, countdown: 3, survivalTick: CFG.rewards.survivalSeconds, bountyIds: new Set(), winnerIds: [], resultRows: [] };
      battle.crafts = run.pilots.map((p, i) => ({ pilot: p, x: positions[i].x, y: positions[i].y, angle: quantize8(positions[i].a), vx: 0, vy: 0, r: CFG.craft.radius, hp: run.settings.maxHp, maxHp: run.settings.maxHp, alive: true, cooldown: .5 + random() * .5, shield: p.item === 'shield' ? p.itemCharges : 0, cloak: 0, kills: 0, survival: 0, lastAttacker: null, aiThink: 0, aiCommand: null, aiTargetId: null, aiTargetTime: 0, aiFireDelay: 0, aiShotDelay: 0, aiStallTime: 0, aiReposition: 0, orbitSign: random() < .5 ? -1 : 1, placedMines: 0, knockT: 0, kvx: 0, kvy: 0 }));
      return battle;
    }

    // Advances the battle by dt seconds. `commands` maps pilot id to
    // { angle, move, fire, useItem } for human pilots; AI pilots decide for
    // themselves. Returns true when the fight itself was simulated (false
    // during the countdown and once the round has ended).
    function step(battle, dt, commands = {}) {
      if (battle.ended) return false;
      for (const c of battle.crafts) if (c.pilot.human && commands[c.pilot.id]?.useItem) useItem(battle, c);
      if (!battle.started) { battle.countdown -= dt; if (battle.countdown <= -.55) battle.started = true; return false; }
      battle.time += dt; battle.timeLeft -= dt; battle.survivalTick -= dt;
      if (battle.survivalTick <= 0) { battle.survivalTick += CFG.rewards.survivalSeconds; battle.crafts.filter(c => c.alive).forEach(c => c.pilot.money += CFG.rewards.survivalTick); }
      for (const c of battle.crafts) {
        if (!c.alive) continue;
        c.survival += dt; c.cooldown -= dt; if (c.cloak > 0) c.cloak = Math.max(0, c.cloak - dt);
        const cmd = c.pilot.human ? (commands[c.pilot.id] || IDLE) : aiCommand(battle, c, dt);
        applyCommand(battle, c, cmd, dt);
      }
      resolveCraftCollisions(battle.crafts); updateLasers(battle, dt); updateBullets(battle, dt); updateMines(battle); updateBounty(battle); checkEnd(battle);
      return true;
    }

    // Visual-only notifications for the client; the simulation never reads them.
    function emit(battle, type, c) { battle.events.push({ type, x: c.x, y: c.y, pilotId: c.pilot.id }); }

    function shotLaneHits(c, target, angle, tx = target.x, ty = target.y) {
      const type = c.pilot.weapon, w = weaponStats(type, c.pilot.weaponLevel), dx = tx - c.x, dy = ty - c.y, cs = Math.cos(angle), sn = Math.sin(angle);
      const along = dx * cs + dy * sn, cross = Math.abs(dx * sn - dy * cs);
      if (type === 'homing') return along > 0 && Math.hypot(dx, dy) <= w.detectRange;
      const bulletRadius = w.radius ?? 4, spread = type === 'triple' ? (w.barrels - 1) / 2 * BARREL_GAP : 0, beam = type === 'laser' ? w.halfWidth : bulletRadius;
      return along > 0 && cross <= target.r + beam + spread + CFG.ai.laneMargin;
    }

    function aiCommand(battle, c, dt) {
      const d = CFG.difficulty[battle.settings.difficulty];
      c.aiThink -= dt; c.aiTargetTime -= dt; c.aiFireDelay = Math.max(0, c.aiFireDelay - dt); c.aiShotDelay = Math.max(0, c.aiShotDelay - dt); c.aiReposition = Math.max(0, c.aiReposition - dt);
      if (c.aiCommand && !c.aiCommand.move && c.aiTargetId !== null) { c.aiStallTime += dt; if (c.aiStallTime >= CFG.ai.stallSeconds) { c.aiStallTime = 0; c.aiReposition = CFG.ai.repositionMin + random() * (CFG.ai.repositionMax - CFG.ai.repositionMin); c.orbitSign *= -1; c.aiThink = 0; } }
      else c.aiStallTime = Math.max(0, c.aiStallTime - dt * 2);
      const targets = battle.crafts.filter(t => t.alive && t.pilot.team !== c.pilot.team && t.cloak <= 0);
      let target = targets.find(t => t.pilot.id === c.aiTargetId);
      if (!target || c.aiTargetTime <= 0) {
        const previousTargetId = c.aiTargetId; target = null; let best = -Infinity;
        for (const t of targets) {
          const ds = dist(c, t);
          const score = c.pilot.personality.near * (1200 - ds) + (c.lastAttacker === t.pilot.id ? 450 * c.pilot.personality.retaliate : 0) + (battle.bountyIds.has(t.pilot.id) ? 400 * c.pilot.personality.bounty : 0) + random() * 70;
          if (score > best) { best = score; target = t; }
        }
        c.aiTargetId = target?.pilot.id ?? null; c.aiTargetTime = 1.2 + random() * 1.4;
        if (c.aiTargetId !== previousTargetId) c.aiStallTime = 0;
        if (random() < .35) c.orbitSign *= -1;
      }
      if (c.aiThink <= 0 || !c.aiCommand) {
        c.aiThink = d.reaction * (.75 + random() * .5);
        if (!target || random() < c.pilot.personality.wander * .035) {
          c.aiCommand = { angle: quantize8(random() * TAU), move: true, fire: false };
        } else {
          const ds = dist(c, target), lead = Math.min(.45, ds / (W[c.pilot.weapon].speed || 800));
          const tx = target.x + target.vx * lead, ty = target.y + target.vy * lead;
          const exactAim = Math.atan2(ty - c.y, tx - c.x), noisyAim = exactAim + (random() - .5) * d.error;
          const aimAngle = quantize8(noisyAim), laneReady = shotLaneHits(c, target, aimAngle, tx, ty);
          let angle = aimAngle, move = true, fire = laneReady && random() < d.fireChance;

          // Close-range AI either stops to fire down one of the eight lanes or
          // commits to one strafing side long enough to avoid indecisive circles.
          if (c.aiReposition > 0) { angle = quantize8(exactAim + c.orbitSign * Math.PI / 2); move = true; fire = false; }
          else if (ds < 205) {
            if (laneReady) { move = false; fire = random() < d.fireChance; }
            else { angle = quantize8(exactAim + c.orbitSign * Math.PI / 2); move = true; fire = false; }
          }

          // Wall escape uses the same instant eight-way turn as player input.
          if (c.x < 65) { angle = 0; move = true; fire = false; }
          else if (c.x > 1135) { angle = Math.PI; move = true; fire = false; }
          if (c.y < 65) { angle = Math.PI / 2; move = true; fire = false; }
          else if (c.y > 735) { angle = -Math.PI / 2; move = true; fire = false; }
          const changedDirection = !c.aiCommand || Math.abs(angleDiff(c.aiCommand.angle, angle)) > .01;
          if (changedDirection) c.aiFireDelay = d.aimSettle;
          if (c.aiFireDelay > 0) fire = false;
          c.aiCommand = { angle, move, fire };
          if (c.pilot.item === 'cloak' && c.pilot.itemCharges > 0 && c.hp === 1 && random() < .12) useItem(battle, c);
          if (c.pilot.item === 'mine' && c.pilot.itemCharges > 0 && ds < 115 && random() < .2) useItem(battle, c);
        }
      }
      return c.aiCommand;
    }

    function applyCommand(battle, c, cmd, dt) {
      if (cmd.angle !== null && cmd.angle !== undefined) c.angle = quantize8(cmd.angle);
      // A craft knocked back by a heavy bullet slides for a moment regardless of its controls.
      if (c.knockT > 0) { c.knockT -= dt; c.vx = c.kvx; c.vy = c.kvy; }
      else if (cmd.move) { c.vx = Math.cos(c.angle) * CFG.craft.speed; c.vy = Math.sin(c.angle) * CFG.craft.speed; } else { c.vx = c.vy = 0; }
      c.x += c.vx * dt; c.y += c.vy * dt; wallClamp(c);
      if (cmd.fire) fire(battle, c);
    }

    function wallClamp(c) {
      if (c.x < c.r) { c.x = c.r; c.vx = Math.max(0, c.vx); }
      if (c.x > ARENA_W - c.r) { c.x = ARENA_W - c.r; c.vx = Math.min(0, c.vx); }
      if (c.y < c.r) { c.y = c.r; c.vy = Math.max(0, c.vy); }
      if (c.y > ARENA_H - c.r) { c.y = ARENA_H - c.r; c.vy = Math.min(0, c.vy); }
    }

    function resolveCraftCollisions(cs) {
      for (let pass = 0; pass < 3; pass++) for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j]; if (!a.alive || !b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || .001, over = a.r + b.r - d; if (over <= 0) continue;
        const nx = dx / d, ny = dy / d, an = a.vx * nx + a.vy * ny, bn = b.vx * nx + b.vy * ny, avg = (an + bn) / 2;
        a.vx += (avg - an) * nx; a.vy += (avg - an) * ny; b.vx += (avg - bn) * nx; b.vy += (avg - bn) * ny;
        a.x -= nx * over / 2; a.y -= ny * over / 2; b.x += nx * over / 2; b.y += ny * over / 2; wallClamp(a); wallClamp(b);
      }
    }

    // One-off angle correction for human pilots; also drives the client's lock-on guide.
    function findAimAssist(battle, c) {
      if (!c?.alive || !c.pilot.human) return null;
      let best = null;
      for (const target of battle.crafts) {
        if (!target.alive || target.pilot.team === c.pilot.team || target.cloak > 0) continue;
        const distance = dist(c, target); if (distance > CFG.aimAssist.range) continue;
        const angle = Math.atan2(target.y - c.y, target.x - c.x), error = Math.abs(angleDiff(c.angle, angle));
        if (error > CFG.aimAssist.cone) continue;
        if (!best || error < best.error - .002 || (Math.abs(error - best.error) < .002 && distance < best.distance)) best = { target, angle, error, distance };
      }
      return best;
    }

    function fire(battle, c) {
      if (c.cooldown > 0 || !c.alive || (!c.pilot.human && c.aiShotDelay > 0)) return;
      const type = c.pilot.weapon, w = weaponStats(type, c.pilot.weaponLevel), assist = findAimAssist(battle, c), shotAngle = assist?.angle ?? c.angle;
      c.cooldown = w.cooldown; if (!c.pilot.human) c.aiShotDelay = w.cooldown + CFG.difficulty[battle.settings.difficulty].shotPause; if (c.cloak > 0) c.cloak = 0;
      const salvo = `${c.pilot.id}-${battle.time.toFixed(3)}`;
      if (type === 'laser') { battle.lasers.push({ owner: c.pilot.id, team: c.pilot.team, x: c.x, y: c.y, angle: shotAngle, t: .5, active: false, salvo, w: w.halfWidth }); return; }
      // Several shots per trigger pull fan out evenly around the aim (or sit side by side for the triple).
      const fan = (n, step) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * step);
      if (type === 'triple') fan(w.barrels, BARREL_GAP).forEach(offset => spawnBullet(battle, c, w, type, salvo, offset, shotAngle));
      else if (type === 'homing') fan(w.missiles, w.spread * DEG).forEach(da => spawnBullet(battle, c, w, type, salvo, 0, shotAngle + da));
      else if (type === 'bounce') fan(w.shots, w.shots > 1 ? 2 * w.spread * DEG : 0).forEach(da => spawnBullet(battle, c, w, type, salvo, 0, shotAngle + da));
      else spawnBullet(battle, c, w, type, salvo, 0, shotAngle);
      if (w.maxLive) {
        const live = battle.bullets.filter(b => !b.dead && b.owner === c.pilot.id && b.type === type);
        live.slice(0, Math.max(0, live.length - w.maxLive)).forEach(b => { b.dead = true; });
      }
    }

    function spawnBullet(battle, c, w, type, salvo, offset = 0, angle = c.angle, x = null, y = null) {
      const px = x ?? c.x + Math.cos(angle) * 25 - Math.sin(angle) * offset, py = y ?? c.y + Math.sin(angle) * 25 + Math.cos(angle) * offset;
      battle.bullets.push({ owner: c.pilot.id, team: c.pilot.team, type, x: px, y: py, px, py, angle, vx: Math.cos(angle) * w.speed, vy: Math.sin(angle) * w.speed, r: w.radius ?? 4, damage: w.damage, strength: w.strength,
        bounces: type === 'bounce' ? w.bounces : 0, bounced: 0, maxHits: w.maxHits ?? 1, wrap: !!w.wrap, blast: w.blast || 0, knockback: w.knockback || 0, arc: w.arc, fragments: w.fragments, group: w.missiles || 1,
        distance: 0, salvo, hit: new Set(), dead: false, life: w.life ?? 5, targetId: null, closestTargetDist: Infinity, homingSpent: false });
    }

    function updateBullets(battle, dt) {
      const bs = battle.bullets;
      // Fragments appended by a splitting bullet are picked up by this same pass.
      for (const b of bs) {
        if (b.dead) continue; b.life -= dt; if (b.life <= 0) { b.dead = true; continue; }
        if (b.type === 'homing') homeBullet(battle, b, dt);
        b.px = b.x; b.py = b.y; b.x += b.vx * dt; b.y += b.vy * dt; b.distance += Math.hypot(b.vx, b.vy) * dt;
        if (b.type === 'split' && b.distance >= 200) {
          b.dead = true; const arc = b.arc * DEG, ring = b.arc >= 360;
          // A full circle has no end fragments, so its spacing divides by n instead of n - 1.
          for (let i = 0; i < b.fragments; i++) spawnFragment(battle, b, ring ? b.angle + i * arc / b.fragments : b.angle + (i - (b.fragments - 1) / 2) * arc / (b.fragments - 1));
          continue;
        }
        handleWalls(b);
        for (const c of battle.crafts) {
          if (!c.alive || c.pilot.team === b.team || b.hit.has(c.pilot.id)) continue;
          if (Math.hypot(c.x - b.x, c.y - b.y) < c.r + b.r) { b.hit.add(c.pilot.id); if (b.knockback) knockBack(c, b); damageCraft(battle, c, b.damage, b.owner, b.salvo); if (b.hit.size >= b.maxHits) b.dead = true; break; }
        }
      }
      for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j]; if (a.dead || b.dead || a.team === b.team) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r) continue;
        if (a.type === 'pierce') { b.dead = true; continue; } if (b.type === 'pierce') { a.dead = true; continue; }
        if (a.strength === b.strength) { a.dead = b.dead = true; } else if (a.strength > b.strength) { a.strength -= b.strength; b.dead = true; } else { b.strength -= a.strength; a.dead = true; }
      }
      // Basic Lv3 bullets blow up however they went: hit, wall, timeout or shot down.
      for (const b of bs) if (b.dead && b.blast && !b.noBlast && !b.blasted) explode(battle, b);
      battle.bullets = bs.filter(b => !b.dead);
    }

    function explode(battle, b) {
      b.blasted = true;
      battle.events.push({ type: 'blast', x: b.x, y: b.y, r: b.blast, pilotId: b.owner });
      for (const c of battle.crafts) if (c.alive && c.pilot.team !== b.team && !b.hit.has(c.pilot.id) && Math.hypot(c.x - b.x, c.y - b.y) < b.blast + c.r) damageCraft(battle, c, 1, b.owner, b.salvo);
      // Enemy bullets in range are worn down like in a bullet-on-bullet hit; whatever this destroys does not explode in turn.
      for (const o of battle.bullets) {
        if (o.dead || o.team === b.team || o.type === 'pierce' || Math.hypot(o.x - b.x, o.y - b.y) >= b.blast + o.r) continue;
        if (o.strength > 1) o.strength--; else { o.dead = true; o.noBlast = true; }
      }
    }

    function knockBack(c, b) {
      const speed = Math.hypot(b.vx, b.vy) || 1, push = b.knockback / CFG.weaponFx.knockTime;
      c.knockT = CFG.weaponFx.knockTime; c.kvx = b.vx / speed * push; c.kvy = b.vy / speed * push;
    }

    function spawnFragment(battle, parent, angle) {
      const fake = { pilot: { id: parent.owner, team: parent.team }, x: parent.x - Math.cos(angle) * 25, y: parent.y - Math.sin(angle) * 25, angle };
      spawnBullet(battle, fake, weaponStats('basic'), 'basic', parent.salvo, 0, angle, parent.x, parent.y);
    }

    function interceptAngle(b, target, speed, maxLead) {
      const rx = target.x - b.x, ry = target.y - b.y, vx = target.vx, vy = target.vy;
      const a = vx * vx + vy * vy - speed * speed, bb = 2 * (rx * vx + ry * vy), cc = rx * rx + ry * ry;
      let t = 0; const disc = bb * bb - 4 * a * cc;
      if (disc >= 0 && Math.abs(a) > .0001) { const root = Math.sqrt(disc), t1 = (-bb - root) / (2 * a), t2 = (-bb + root) / (2 * a), valid = [t1, t2].filter(v => v > 0); if (valid.length) t = Math.min(...valid); }
      if (!t) t = Math.sqrt(cc) / speed;
      t = Math.min(maxLead, t);
      return Math.atan2(target.y + vy * t - b.y, target.x + vx * t - b.x);
    }

    function homeBullet(battle, b, dt) {
      const w = W.homing; if (b.homingSpent) return;
      let target = battle.crafts.find(c => c.alive && c.pilot.id === b.targetId && c.pilot.team !== b.team);
      if (!target) {
        // Missiles from the same trigger pull prefer different targets, each the one closest to its own heading so the fan
        // does not cross over; they double up only when nobody else is in range. A lone missile simply takes the nearest.
        const taken = new Set(battle.bullets.filter(o => o !== b && !o.dead && o.salvo === b.salvo && o.targetId !== null).map(o => o.targetId));
        let fresh = null, freshD = w.detectRange, freshScore = Infinity, any = null, anyD = w.detectRange;
        for (const c of battle.crafts) {
          if (!c.alive || c.pilot.team === b.team) continue; const d = Math.hypot(c.x - b.x, c.y - b.y);
          if (d < anyD) { anyD = d; any = c; }
          const score = b.group > 1 ? Math.abs(angleDiff(b.angle, Math.atan2(c.y - b.y, c.x - b.x))) * 1e4 + d : d;
          if (d < w.detectRange && score < freshScore && !taken.has(c.pilot.id)) { freshScore = score; freshD = d; fresh = c; }
        }
        target = fresh || any;
        if (target) { b.targetId = target.pilot.id; b.closestTargetDist = fresh ? freshD : anyD; }
      }
      if (!target) return;
      const targetDist = Math.hypot(target.x - b.x, target.y - b.y);
      if (targetDist < b.closestTargetDist) b.closestTargetDist = targetDist;
      else if (b.closestTargetDist < 70 && targetDist > b.closestTargetDist + 12) { b.homingSpent = true; b.targetId = null; return; }
      const direct = Math.atan2(target.y - b.y, target.x - b.x);
      let desired = interceptAngle(b, target, w.speed, w.maxLead);
      // Near impact, prefer the actual hull over an aggressive lead point.
      if (targetDist < 120 && Math.abs(angleDiff(b.angle, direct)) < Math.PI / 2) desired = direct;
      const dif = angleDiff(b.angle, desired), turn = w.turnRate * dt;
      b.angle += clamp(dif, -turn, turn); b.vx = Math.cos(b.angle) * w.speed; b.vy = Math.sin(b.angle) * w.speed;
    }

    function handleWalls(b) {
      // Pierce Lv3 leaves through one wall and comes back in through the opposite one.
      if (b.wrap) { if (b.x < 0) b.x += ARENA_W; else if (b.x > ARENA_W) b.x -= ARENA_W; if (b.y < 0) b.y += ARENA_H; else if (b.y > ARENA_H) b.y -= ARENA_H; return; }
      if (b.x < b.r || b.x > ARENA_W - b.r) { if (b.bounces > 0) { b.vx *= -1; b.angle = Math.atan2(b.vy, b.vx); b.bounces--; b.bounced++; b.x = clamp(b.x, b.r, ARENA_W - b.r); } else b.dead = true; }
      if (b.y < b.r || b.y > ARENA_H - b.r) { if (b.bounces > 0) { b.vy *= -1; b.angle = Math.atan2(b.vy, b.vx); b.bounces--; b.bounced++; b.y = clamp(b.y, b.r, ARENA_H - b.r); } else b.dead = true; }
    }

    function updateLasers(battle, dt) {
      for (const l of battle.lasers) {
        l.t -= dt;
        if (l.t <= 0 && !l.active) {
          l.active = true; l.t = .12; const dx = Math.cos(l.angle), dy = Math.sin(l.angle);
          for (const c of battle.crafts) { if (!c.alive || c.pilot.team === l.team) continue; const rx = c.x - l.x, ry = c.y - l.y, along = rx * dx + ry * dy, perp = Math.abs(rx * dy - ry * dx); if (along > 0 && perp < c.r + l.w) damageCraft(battle, c, 1, l.owner, l.salvo); }
        }
      }
      battle.lasers = battle.lasers.filter(l => l.t > 0);
    }

    function damageCraft(battle, c, amount, attackerId, salvo) {
      if (!c.alive) return; c.lastAttacker = attackerId;
      const attacker = battle.crafts.find(x => x.pilot.id === attackerId); if (attacker) attacker.aiStallTime = 0;
      if (c.shield > 0) { const used = Math.min(c.shield, amount); c.shield -= used; c.pilot.itemCharges = c.shield; amount -= used; emit(battle, 'shield', c); }
      if (amount <= 0) return;
      c.hp -= amount; emit(battle, 'hit', c);
      if (c.hp <= 0) killCraft(battle, c, attackerId);
    }

    function killCraft(battle, c, attackerId) {
      c.alive = false; c.hp = 0; emit(battle, 'kill', c);
      const killer = battle.crafts.find(x => x.pilot.id === attackerId);
      if (killer && killer !== c) { killer.kills++; killer.pilot.totalKills++; killer.pilot.money += CFG.rewards.kill; if (battle.bountyIds.has(c.pilot.id)) killer.pilot.money += CFG.rewards.bounty; }
      c.pilot.weapon = 'basic'; c.pilot.weaponLevel = 1; c.pilot.item = null; c.pilot.itemCharges = 0; c.pilot.aliveLast = false;
      if (!CFG.rules.minesPersistAfterDeath) battle.mines = battle.mines.filter(m => m.owner !== c.pilot.id);
    }

    function useItem(battle, c) {
      if (!c || !c.alive || !c.pilot.item || c.pilot.itemCharges <= 0) return;
      const type = c.pilot.item;
      if (type === 'mine') { if (c.placedMines >= 2) return; battle.mines.push({ x: c.x, y: c.y, owner: c.pilot.id, team: c.pilot.team, r: 13 }); c.placedMines++; c.pilot.itemCharges--; }
      else if (type === 'cloak') { c.cloak = 5; c.pilot.itemCharges--; }
    }

    function updateMines(battle) {
      for (const m of battle.mines) for (const c of battle.crafts) {
        if (!c.alive || c.pilot.team === m.team) continue;
        if (dist(m, c) < m.r + c.r) { damageCraft(battle, c, 1, m.owner, `mine-${m.owner}-${battle.time}`); m.dead = true; break; }
      }
      battle.mines = battle.mines.filter(m => !m.dead);
    }

    function updateBounty(battle) {
      const crafts = battle.crafts, alive = crafts.filter(c => c.alive); if (!alive.length) return;
      if (battle.settings.mode === 'ffa') { const max = Math.max(...crafts.map(c => c.kills)); battle.bountyIds = new Set(max > 0 ? crafts.filter(c => c.kills === max && c.alive).map(c => c.pilot.id) : []); return; }
      const scores = new Map(); crafts.forEach(c => scores.set(c.pilot.team, (scores.get(c.pilot.team) || 0) + c.kills));
      const maxTeam = Math.max(...scores.values()); if (maxTeam <= 0) { battle.bountyIds.clear(); return; }
      const topTeams = [...scores].filter(([, v]) => v === maxTeam).map(([k]) => k), ids = [];
      for (const team of topTeams) { const members = crafts.filter(c => c.pilot.team === team && c.alive), max = Math.max(...members.map(c => c.kills)); ids.push(...members.filter(c => c.kills === max).map(c => c.pilot.id)); }
      battle.bountyIds = new Set(ids);
    }

    function checkEnd(battle) {
      const alive = battle.crafts.filter(c => c.alive), teams = new Set(alive.map(c => c.pilot.team));
      if (teams.size > 1 && battle.timeLeft > 0) return;
      let winners;
      if (teams.size <= 1 && alive.length) winners = alive;
      else if (battle.settings.mode === 'team') {
        const teamScores = new Map();
        for (const c of alive) { const s = teamScores.get(c.pilot.team) || { hp: 0, kills: 0 }; s.hp += c.hp + c.shield; s.kills += c.kills; teamScores.set(c.pilot.team, s); }
        const ranked = [...teamScores].sort((a, z) => z[1].hp - a[1].hp || z[1].kills - a[1].kills);
        winners = alive.filter(c => c.pilot.team === ranked[0][0]);
      } else {
        const ranked = [...alive].sort((a, z) => (z.hp + z.shield) - (a.hp + a.shield) || z.kills - a.kills || z.survival - a.survival || random() - .5);
        winners = [ranked[0] || battle.crafts[0]];
      }
      finishRound(battle, winners);
    }

    function finishRound(battle, winners) {
      if (battle.ended) return; battle.ended = true; battle.winnerIds = winners.map(c => c.pilot.id);
      const winningTeams = new Set(winners.map(c => c.pilot.team));
      for (const c of battle.crafts) {
        const win = winningTeams.has(c.pilot.team); let outcome;
        if (win) { outcome = CFG.rewards.win; c.pilot.lossStreak = 0; c.pilot.wins++; }
        else { c.pilot.lossStreak++; outcome = Math.min(CFG.rewards.lossCap, CFG.rewards.lossBase + (c.pilot.lossStreak - 1) * CFG.rewards.lossStep); }
        c.pilot.money += outcome; if (c.alive) c.pilot.aliveLast = true;
        const killPay = c.kills * CFG.rewards.kill, survivePay = Math.floor(c.survival / CFG.rewards.survivalSeconds) * CFG.rewards.survivalTick;
        battle.resultRows.push({ c, win, killPay, survivePay, outcome, total: killPay + survivePay + outcome });
      }
    }

    return { createRun, advanceRound, autoBuy, buy, weaponOffer, itemOffer, weaponStats, startBattle, step, findAimAssist };
  }

  const api = { createCore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ArenaCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
