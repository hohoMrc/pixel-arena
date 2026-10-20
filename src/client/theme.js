/**
 * 主題設定：換風格／換 IP 只要改這個檔案和 public/assets/ 裡的圖片。
 *
 * - path：圖片放在 public/ 底下的路徑。檔案不存在時會自動用 placeholder 色塊代替，
 *   所以可以先玩、之後一張一張補圖。
 * - size：placeholder 的尺寸，也是建議的原圖尺寸（像素圖請用這個大小或整數倍）。
 * - color：placeholder 的主色。
 */
export const theme = {
  name: "預設像素風",
  backgroundColor: "#1d1f2b",

  assets: {
    floor:       { path: "assets/floor.png",       size: [64, 64], color: 0x2e3346 },
    // 場地外框：上方是牆的正面（有高度，角色頭會疊在上面），左右下是牆頂
    // 想改成河流、樹叢等，換這兩張圖即可（需可無縫拼接）
    wallFace:    { path: "assets/wall_face.png",   size: [64, 64], color: 0x55607a },
    wallTop:     { path: "assets/wall_top.png",    size: [64, 64], color: 0x4a5878 },
    // 障礙物：底部對齊佔地底部，比角色高才擋得住後面的人
    pillar:      { path: "assets/pillar.png",      size: [25, 61], color: 0x6b7590 },
    // 柱子被打壞後留在地上的碎石。沒有圖片時用程式畫的 placeholder（之後可以用 Codex 產圖換掉）
    rubble:      { size: [30, 14], color: 0x6b7590 },
    fireball:    { path: "assets/fireball.png",    size: [17, 11], color: 0xff8a3d },
    bigfireball: { path: "assets/bigfireball.png", size: [39, 23], color: 0xff4d2e },
    poisonball:  { path: "assets/poisonball.png",  size: [17, 11], color: 0x6dff5c }, // 火球轉成綠色
    qiball:      { path: "assets/qiball.png",      size: [17, 11], color: 0xffd23f }, // 火球轉成金色
    // 角色外觀（skin 0~3），玩家在進場畫面選。32×40，面朝右，腳貼齊圖片底部
    player0:     { path: "assets/player0.png",     size: [32, 40], color: 0x4fa3ff },
    player1:     { path: "assets/player1.png",     size: [32, 40], color: 0xff5c7a },
    player2:     { path: "assets/player2.png",     size: [32, 40], color: 0x5fd17a },
    player3:     { path: "assets/player3.png",     size: [32, 40], color: 0xffd23f },
    // 走路動畫：橫排 spritesheet，每格 32×40。沒有這張圖時角色移動就不播動畫
    player0_walk: { path: "assets/player0_walk.png", sheet: [32, 40] },
    player1_walk: { path: "assets/player1_walk.png", sheet: [32, 40] },
    player2_walk: { path: "assets/player2_walk.png", sheet: [32, 40] },
    player3_walk: { path: "assets/player3_walk.png", sheet: [32, 40] },
    // 正面（往下走）、背面（往上走）：4 格走路動畫（左腳、站立、右腳、站立），站著時用 IDLE_FRAME 那格。
    // 沒有這些圖時，往上下走也用側面圖
    player0_front: { path: "assets/player0_front.png", sheet: [32, 40] },
    player1_front: { path: "assets/player1_front.png", sheet: [32, 40] },
    player2_front: { path: "assets/player2_front.png", sheet: [32, 40] },
    player3_front: { path: "assets/player3_front.png", sheet: [32, 40] },
    player0_back:  { path: "assets/player0_back.png",  sheet: [32, 40] },
    player1_back:  { path: "assets/player1_back.png",  sheet: [32, 40] },
    player2_back:  { path: "assets/player2_back.png",  sheet: [32, 40] },
    player3_back:  { path: "assets/player3_back.png",  sheet: [32, 40] },
    // 技能命中特效：5 格（閃光 → 火球 → 爆炸 → 碎煙 → 淡出），每格 40×40
    explosion:    { path: "assets/explosion.png",    sheet: [40, 40] },
    explosion_poison: { path: "assets/explosion_poison.png", sheet: [40, 40] }, // 綠色版爆炸（毒系技能）
    explosion_qi:     { path: "assets/explosion_qi.png",     sheet: [40, 40] }, // 金色版爆炸（金武僧）
  },

  /**
   * 音效：key → 檔案路徑。用 tools/make_sfx.mjs 產生的 8-bit 音效，可直接換成其他 .wav / .mp3。
   * 檔案不存在時就不播，不會出錯。
   */
  sounds: {
    cast_fireball:    "assets/sfx/cast_fireball.wav",
    cast_bigfireball: "assets/sfx/cast_bigfireball.wav",
    explode_small:    "assets/sfx/explode_small.wav",
    explode_big:      "assets/sfx/explode_big.wav",
    fizzle:           "assets/sfx/fizzle.wav",
    hurt:             "assets/sfx/hurt.wav",
    death:            "assets/sfx/death.wav",
    respawn:          "assets/sfx/respawn.wav",
    dash:             "assets/sfx/dash.wav",
    beep:             "assets/sfx/beep.wav",
    go:               "assets/sfx/go.wav",
    win:              "assets/sfx/win.wav",
    lose:             "assets/sfx/lose.wav",
    pillar_hit:       "assets/sfx/pillar_hit.wav",
    pillar_break:     "assets/sfx/pillar_break.wav",
    slash:            "assets/sfx/slash.wav",
    slash_hit:        "assets/sfx/slash_hit.wav",
    guard:            "assets/sfx/guard.wav",
    block:            "assets/sfx/block.wav",
    whirl:            "assets/sfx/whirl.wav",
    poison_shot:      "assets/sfx/poison_shot.wav",
    poison_hit:       "assets/sfx/poison_hit.wav",
    swamp:            "assets/sfx/swamp.wav",
    vine:             "assets/sfx/vine.wav",
    qi_shot:          "assets/sfx/qi_shot.wav",
    qi_hit:           "assets/sfx/qi_hit.wav",
    barrier:          "assets/sfx/barrier.wav",
    barrier_break:    "assets/sfx/barrier_break.wav",
    roar:             "assets/sfx/roar.wav",
  },
  /** 每個技能（索引 = SKILLS 的技能編號）施放和命中時播哪個音效 */
  skillSounds: [
    { cast: "cast_fireball", hit: "explode_small" },
    { cast: "cast_bigfireball", hit: "explode_big" },
    { cast: "dash" },
    { cast: "cast_bigfireball", hit: "explode_big" },
    { cast: "slash", hit: "slash_hit" },   // 揮砍
    { cast: "guard" },                     // 舉盾（擋下時播 block）
    { cast: "whirl", hit: "slash_hit" },   // 旋風斬
    { cast: "dash" },                      // 紅劍士的衝刺
    { cast: "poison_shot", hit: "poison_hit" }, // 毒液彈
    { cast: "swamp" },                          // 毒沼
    { cast: "swamp", hit: "vine" },             // 藤蔓（預告時、定身時）
    { cast: "qi_shot", hit: "qi_hit" },         // 氣功波
    { cast: "barrier", hit: "block" },          // 金鐘罩（吸收傷害時播 hit，被打破播 barrier_break）
    { cast: "roar", hit: "qi_hit" },            // 獅子吼
  ],
  /** 命中特效用哪張爆炸圖（沒寫 = explosion），索引 = 技能編號 */
  impactTextures: { 8: "explosion_poison", 10: "explosion_poison", 11: "explosion_qi", 13: "explosion_qi" },
  /** 指定地點技能預告圈的顏色（沒寫 = 紅色），索引 = 技能編號 */
  targetColors: { 9: 0x6dff5c, 10: 0x3fbf4a },
  /** 綠巫師的狀態效果 */
  witchFx: {
    swampColor: 0x5fd35a,   // 毒沼
    swampDark: 0x2f8a3a,    // 毒沼中間比較深的一層
    swampMist: 0xa8ff9a,    // 毒沼冒出的毒氣
    swampSplash: 14,        // 毒沼落地時噴出幾滴
    dripEveryMs: 45,        // 毒液彈飛行時多久滴一滴
    splatDrops: 10,         // 毒液彈打中時噴出幾滴
    splatMs: 700,           // 打中後地上那灘毒液多久消失
    vineColor: 0x3fbf4a,    // 被定身時腳邊的藤蔓
    poisonTint: 0x9dff8a,   // 中毒時角色染綠（MULTIPLY）
    leafColor: 0x8be36b,    // 藤蔓上的葉子
    vineDark: 0x2a7a35,     // 藤蔓的暗部（外框）
    rootTendrils: 8,        // 藤蔓預告圈邊緣長出幾條
    burstVines: 14,         // 藤蔓爆發時竄出幾條
    burstMs: 420,           // 爆發的藤蔓多久消失
    wrapGrowMs: 220,        // 定身時藤蔓從腳纏到腰要多久
  },
  /** 金武僧的效果 */
  monkFx: {
    barrierColor: 0xffd23f, // 金鐘罩
    bellDark: 0xb8860b,     // 金鐘的暗部（花紋、裂痕）
    bellDropMs: 260,        // 金鐘從天上罩下來要多久
    bellShards: 14,         // 金鐘被打破時碎成幾片
    roarColor: 0xffe28a,    // 獅子吼的震波
    roarMs: 300,            // 每一圈震波擴散多久
    roarRings: 3,           // 幾圈震波
    roarRingGapMs: 80,      // 每圈間隔
    roarLines: 12,          // 往外噴的速度線
    roarDust: 14,           // 地上揚起的塵土
    knockTrail: { everyMs: 35, fadeMs: 260, alpha: 0.55, tint: 0xffd23f }, // 被震飛時的金色殘影
    qiColor: 0xffd23f,      // 氣功波的光暈
    qiCore: 0xfff6c8,       // 氣功波的核心（接近白色）
    qiTrail: { everyMs: 25, fadeMs: 220 }, // 氣功波飛行的殘影
    qiPierceLines: 8,       // 貫穿時往前噴的光線
  },
  /** 每個角色的代表色（死亡碎片、復活光柱用），索引 = skin */
  skinColors: [0x7fb8ff, 0xff6b5c, 0x6dd35a, 0xffd23f],
  /** 傷害數字 */
  damageText: {
    selfColor: "#ff5c5c",   // 自己被打
    otherColor: "#ffffff",  // 打到別人
    bigColor: "#ffd23f",    // 重擊（≥ bigAt）
    poisonColor: "#8be36b", // 中毒、毒沼
    bigAt: 30,
    riseMs: 650,            // 往上飄多久
  },
  /** 衝刺殘影：每幾毫秒留一個、殘影多久消失 */
  dashTrail: { everyMs: 30, fadeMs: 220, alpha: 0.5 },
  /** 一般衝刺依角色換顏色：殘影顏色、沿路灑出的粒子顏色（索引 = skin；紅劍士有自己的，見 meleeFx） */
  dashFx: {
    0: { tint: 0x7fb8ff, particles: [0xcfe8ff, 0x7fb8ff, 0xffffff] }, // 藍法師：藍色魔力星點
    2: { tint: 0x6dd35a, particles: [0x8be36b, 0x3fbf4a] },           // 綠巫師：綠葉
    3: { tint: 0xffd23f, particles: [0xfff6c8, 0xffd23f] },           // 金武僧：金色氣
  },
  /** 藍法師的火系技能（火球、爆炎、流星雨） */
  fireFx: {
    skills: [0, 1, 3],
    embers: [0xffe27a, 0xff9a3c, 0xff4d2e], // 火星的顏色（亮 → 暗）
    emberEveryMs: 28,      // 火球飛行時多久噴一顆火星
    scorchMs: 1500,        // 地上焦痕多久消失
    runeColor: 0xffb04a,   // 預告圈裡的魔法陣
    meteorSlant: 0.55,     // 流星斜著掉：水平位移 / 落下高度
  },
  /** 別人的聲音（施放、死亡）音量，自己的是 1 */
  othersVolume: 0.5,

  /** 外框厚度（像素）。上方要夠高，角色走到最上面時頭才不會被切掉 */
  border: { top: 64, side: 16, bottom: 16 },
  /** 手機上看到的遊戲畫面大小（遊戲單位）。場地比這個大，鏡頭跟著自己移動 */
  viewport: { width: 416, height: 512 },
  /** 右上角小地圖 */
  minimap: { width: 64, margin: 6, alpha: 0.75 },

  /** 命中特效每秒幾格；沒打中時只播最後兩格（冒煙） */
  impactFrameRate: 16,

  /** 走路動畫每秒幾格 */
  walkFrameRate: 8,

  // 技能按鈕上的圖示（文字或 emoji；之後也可以改成圖片）
  // 索引 = SKILLS 的技能編號
  skillIcons: ["🔥", "💥", "💨", "☄️", "🗡️", "🛡️", "🌀", "💨", "🧪", "☠️", "🌿", "🌟", "🔔", "🦁"],
  /** 進場畫面的角色名稱，順序 = skin 編號（數量要和 shared/constants.js 的 SKIN_COUNT 一致） */
  skins: ["藍法師", "紅劍士", "綠巫師", "金武僧"],
  /** 拖曳瞄準時瞄準線的顏色，索引 = SKILLS 的技能編號 */
  aimGuideColors: [0xff8a3d, 0xff4d2e, 0xffffff, 0xffd23f, 0xffffff, 0x7fd4ff, 0xff6b5c, 0xffffff, 0x9dff8a, 0x6dff5c, 0x3fbf4a, 0xffd23f, 0xffd23f, 0xffe28a],
  /** 近戰技能的畫面效果 */
  meleeFx: {
    slashColor: 0xfff4d6,  // 揮砍刀光
    slashMs: 140,          // 揮砍的弧形刀光多久消失
    slashSweepMs: 70,      // 刀光從一邊掃到另一邊要多久
    guardColor: 0x7fd4ff,  // 盾牌
    guardEdge: 0xe8f8ff,   // 盾牌外緣的亮邊
    guardRaiseMs: 120,     // 舉盾時盾牌展開要多久
    blockSparks: 9,        // 擋下攻擊時噴出的火花數
    whirlColor: 0xff6b5c,  // 旋風斬的圈
    whirlSpinMs: 70,       // 旋轉時角色多久翻一次面
    whirlBladeColor: 0xfff4d6, // 旋風斬刀刃的亮邊
    whirlDebrisEveryMs: 35,    // 旋轉時多久甩出一顆碎屑
    cutSkills: [6],        // 打中時用刀光（不是爆炸）的技能編號：旋風斬
    cutColor: 0xff6b5c,    // 刀光外圈（裡面是白色）
    cutLength: 28,         // 刀光長度
    cutMs: 200,            // 刀光多久消失
    // 劍士衝刺（技能編號 7）：紅色殘影、地上一道劍氣軌跡、起步揚塵、煞車揚塵
    dashSkills: [7],
    dashTint: 0xff6b5c,    // 殘影顏色
    dashStreakColor: 0xffb199, // 地上的劍氣軌跡
    dashStreakMs: 260,     // 軌跡多久消失
    dashDust: 8,           // 起步、煞車時揚起幾團塵土
  },
};

export const playerTextureKey = (skin) => `player${skin}`;
export const walkTextureKey = (skin) => `player${skin}_walk`;
/** 正面 / 背面的走路圖（dir = "front" | "back"） */
export const facingTextureKey = (skin, dir) => `player${skin}_${dir}`;
/** 正面 / 背面圖裡「站著」用哪一格（0 開始） */
export const IDLE_FRAME = 1;
