/**
 * 8-bit 風格音效產生器：用程式合成 .wav，不需要任何套件。
 *
 * 用法：node tools/make_sfx.mjs
 * 輸出：public/assets/sfx/*.wav（會覆蓋同名檔）
 *
 * 想調整聲音：改下面 SOUNDS 裡的參數再重跑。
 * 想換成真實音效：直接把同名 .wav 放進 public/assets/sfx/，或改 src/client/theme.js 的路徑。
 */
import { writeFileSync, mkdirSync } from "node:fs";

const RATE = 22050;
const OUT_DIR = new URL("../public/assets/sfx/", import.meta.url);

// 固定種子的亂數，每次產生的雜訊都一樣（重跑結果不變）
let seed = 1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;

/**
 * 合成一段聲音。
 * @param {object} o
 * @param {number} o.duration 秒
 * @param {"square"|"triangle"|"noise"} o.wave 波形
 * @param {[number, number]} [o.freq] 起始 / 結束頻率（Hz），中間指數滑音
 * @param {number} [o.attack] 淡入秒數
 * @param {number} [o.decay] 衰減速度（越大越快消失）
 * @param {[number, number]} [o.lowpass] 低通濾波起始 / 結束強度（0~1，越小越悶）
 * @param {number} [o.noiseMix] 混入多少雜訊（0~1）
 * @param {number} [o.vibrato] 顫音頻率（Hz）
 */
function synth(o) {
  const n = Math.floor(o.duration * RATE);
  const out = new Float32Array(n);
  const [f0, f1] = o.freq ?? [440, 440];
  const [lp0, lp1] = o.lowpass ?? [1, 1];
  let phase = 0, lp = 0, held = 0;

  for (let i = 0; i < n; i++) {
    const t = i / n;
    const freq = f0 * (f1 / f0) ** t * (o.vibrato ? 1 + 0.03 * Math.sin(2 * Math.PI * o.vibrato * i / RATE) : 1);
    phase = (phase + freq / RATE) % 1;

    let s;
    if (o.wave === "square") s = phase < 0.5 ? 1 : -1;
    else if (o.wave === "triangle") s = 4 * Math.abs(phase - 0.5) - 1;
    else {
      // 雜訊依頻率取樣保持，頻率越低聲音越粗（爆炸感）
      if (Math.floor(phase * 2) !== Math.floor(((phase - freq / RATE) + 1) % 1 * 2)) held = rand();
      s = held;
    }
    if (o.noiseMix) s = s * (1 - o.noiseMix) + rand() * o.noiseMix;

    // 一階低通濾波，強度隨時間變化
    const k = lp0 + (lp1 - lp0) * t;
    lp += (s - lp) * k;

    const attack = o.attack ? Math.min(1, (i / RATE) / o.attack) : 1;
    // 結尾 15ms 強制淡出，避免聲音突然斷掉產生「啪」聲
    const fadeOut = Math.min(1, (n - i) / (0.015 * RATE));
    const env = attack * fadeOut * Math.exp(-(o.decay ?? 4) * t);
    out[i] = lp * env;
  }
  return out;
}

/** 依序接起多段聲音（琶音用） */
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

const SOUNDS = {
  // 施放技能
  cast_fireball: () => synth({ duration: 0.16, wave: "square", freq: [880, 260], decay: 5, lowpass: [0.6, 0.2], noiseMix: 0.25 }),
  cast_bigfireball: () => synth({ duration: 0.38, wave: "square", freq: [420, 90], decay: 3, lowpass: [0.5, 0.1], noiseMix: 0.45, vibrato: 18 }),
  // 命中爆炸
  explode_small: () => synth({ duration: 0.28, wave: "noise", freq: [3000, 400], decay: 6, lowpass: [0.7, 0.15] }),
  explode_big: () => synth({ duration: 0.6, wave: "noise", freq: [1600, 120], decay: 4, lowpass: [0.6, 0.06] }),
  // 沒打中，冒煙
  fizzle: () => synth({ duration: 0.12, wave: "noise", freq: [5000, 2000], decay: 7, lowpass: [0.25, 0.08] }),
  // 倒數：3、2、1 的「嗶」和開始的高音
  beep: () => synth({ duration: 0.12, wave: "square", freq: [660, 660], decay: 2, lowpass: [0.3, 0.3] }),
  go: () => synth({ duration: 0.35, wave: "square", freq: [1320, 1320], decay: 3, lowpass: [0.3, 0.3] }),
  // 勝利：往上的大三和弦琶音，最後一個音拉長
  win: () => concat(
    ...[523, 659, 784, 1047].map((f, i) => synth({ duration: i === 3 ? 0.6 : 0.11, wave: "square", freq: [f, f], decay: i === 3 ? 3 : 1, lowpass: [0.3, 0.3], vibrato: i === 3 ? 6 : 0 })),
  ),
  // 失敗：往下的小調
  lose: () => concat(
    ...[440, 392, 330, 262].map((f, i) => synth({ duration: i === 3 ? 0.55 : 0.16, wave: "triangle", freq: [f, f * 0.98], decay: i === 3 ? 4 : 1.2 })),
  ),
  // 衝刺：往上滑的「咻」
  dash: () => synth({ duration: 0.18, wave: "noise", freq: [1500, 7000], attack: 0.03, decay: 5, lowpass: [0.15, 0.5] }),
  // 自己被打中
  hurt: () => synth({ duration: 0.14, wave: "square", freq: [330, 120], decay: 4, lowpass: [0.4, 0.3] }),
  // 死亡：往下的琶音
  death: () => concat(
    ...[523, 392, 311, 196].map((f, i) => synth({ duration: i === 3 ? 0.35 : 0.09, wave: "triangle", freq: [f, f * 0.97], decay: i === 3 ? 5 : 1.5 })),
  ),
  // 復活：往上的琶音
  respawn: () => concat(
    ...[392, 523, 659, 784].map((f, i) => synth({ duration: i === 3 ? 0.22 : 0.07, wave: "square", freq: [f, f], decay: i === 3 ? 4 : 1, lowpass: [0.35, 0.35] })),
  ),
};

/** 正規化音量並寫成 16-bit 單聲道 WAV */
function writeWav(name, samples, peak = 0.8) {
  const max = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round((v / max) * peak * 32767), i * 2));

  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);

  writeFileSync(new URL(`${name}.wav`, OUT_DIR), Buffer.concat([header, data]));
  console.log(`${name}.wav  ${(samples.length / RATE).toFixed(2)}s`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, make] of Object.entries(SOUNDS)) writeWav(name, make());
