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
  ],
  /** 衝刺殘影：每幾毫秒留一個、殘影多久消失 */
  dashTrail: { everyMs: 30, fadeMs: 220, alpha: 0.5 },
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
  skillIcons: ["🔥", "💥", "💨", "☄️", "🗡️", "🛡️", "🌀"],
  /** 進場畫面的角色名稱，順序 = skin 編號（數量要和 shared/constants.js 的 SKIN_COUNT 一致） */
  skins: ["藍法師", "紅劍士", "綠巫師", "金武僧"],
  /** 拖曳瞄準時瞄準線的顏色，索引 = SKILLS 的技能編號 */
  aimGuideColors: [0xff8a3d, 0xff4d2e, 0xffffff, 0xffd23f, 0xffffff, 0x7fd4ff, 0xff6b5c],
  /** 近戰技能的畫面效果 */
  meleeFx: {
    slashColor: 0xfff4d6,  // 揮砍刀光
    slashMs: 140,          // 刀光多久消失
    guardColor: 0x7fd4ff,  // 盾牌
    whirlColor: 0xff6b5c,  // 旋風斬的圈
    whirlSpinMs: 70,       // 旋轉時角色多久翻一次面
  },
};

export const playerTextureKey = (skin) => `player${skin}`;
export const walkTextureKey = (skin) => `player${skin}_walk`;
/** 正面 / 背面的走路圖（dir = "front" | "back"） */
export const facingTextureKey = (skin, dir) => `player${skin}_${dir}`;
/** 正面 / 背面圖裡「站著」用哪一格（0 開始） */
export const IDLE_FRAME = 1;
