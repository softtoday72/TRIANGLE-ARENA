globalThis.ARENA_CONFIG = Object.freeze({
  arena: { width: 1200, height: 800, roundTime: 90 },
  craft: { radius: 18, speed: 200, turnMode: 'instant-8-way' },
  aimAssist: { cone: Math.PI / 18, range: 900, guideLength: 150 },
  ai: { laneMargin: 3, stallSeconds: 2.8, repositionMin: .8, repositionMax: 1.2 },
  rewards: { kill: 300, survivalTick: 20, survivalSeconds: 10, bounty: 200, win: 300, lossBase: 100, lossStep: 50, lossCap: 300 },
  rules: { friendlyMinesVisible: true, minesPersistAfterDeath: true, laserClearsBullets: false },
  difficulty: {
    easy: { reaction: .58, error: .26, fireChance: .58, aimSettle: .75, shotPause: .45 },
    normal: { reaction: .34, error: .14, fireChance: .72, aimSettle: .5, shotPause: .3 },
    hard: { reaction: .18, error: .06, fireChance: .9, aimSettle: .32, shotPause: .15 }
  }
});

globalThis.WEAPONS = Object.freeze({
  basic:   { name:'基礎單發', price:0, desc:'穩定可靠｜間隔 1.2 秒', cooldown:1.2, speed:400, damage:1, strength:1 },
  triple:  { name:'三管並射', price:300, desc:'平行三發｜間隔 1.4 秒', cooldown:1.4, speed:400, damage:1, strength:1 },
  rapid:   { name:'高速彈', price:400, desc:'高射速壓制｜間隔 0.4 秒', cooldown:.4, speed:400, damage:1, strength:1 },
  homing:  { name:'追熱彈', price:500, desc:'強力鎖定｜間隔 1.2 秒', cooldown:1.2, speed:360, damage:1, strength:1, detectRange:520, turnRate:Math.PI*8/9, maxLead:.75, life:6 },
  heavy:   { name:'大力彈', price:600, desc:'2 點傷害｜間隔 1.7 秒', cooldown:1.7, speed:250, damage:2, strength:2, threeHpOnly:true },
  bounce:  { name:'反彈彈', price:350, desc:'牆面反彈｜間隔 1.2 秒', cooldown:1.2, speed:400, damage:1, strength:1 },
  pierce:  { name:'穿透彈', price:450, desc:'穿過兩名目標｜間隔 1.4 秒', cooldown:1.4, speed:380, damage:1, strength:99 },
  laser:   { name:'雷射', price:700, desc:'0.5 秒預警｜間隔 2.7 秒', cooldown:2.7, damage:1, strength:0 },
  split:   { name:'分裂彈', price:550, desc:'200px 後分裂｜間隔 1.45 秒', cooldown:1.45, speed:360, damage:1, strength:1 }
});

globalThis.ITEMS = Object.freeze({
  mine:   { name:'地雷', price:200, desc:'2 顆隱形陷阱｜接觸傷害 1', charges:2 },
  shield: { name:'護盾', price:400, desc:'開場生效｜吸收 2 點傷害', charges:2 },
  cloak:  { name:'隱形', price:300, desc:'隱形 5 秒｜射擊即現形', charges:1 }
});

if (typeof module !== 'undefined' && module.exports) module.exports = { ARENA_CONFIG: globalThis.ARENA_CONFIG, WEAPONS: globalThis.WEAPONS, ITEMS: globalThis.ITEMS };
