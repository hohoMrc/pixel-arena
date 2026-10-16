import { ARENA_WIDTH, ARENA_HEIGHT, PLAYER_HALF, PLAYER_SPEED, SKILLS, DASH_INDEX } from "./constants.js";
import { obstacleHitByBox } from "./obstacles.js";

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

/**
 * 角色移動的唯一一步，伺服器和客戶端預測都跑這支函式。
 *
 * 必須是純函式：只依賴參數，不讀時間、不用亂數。
 * 只要兩邊算法一致，客戶端預測就不會和伺服器結果對不上。
 *
 * 衝刺也在這裡處理（包含冷卻），所以按下衝刺時客戶端能立刻預測，不會被伺服器拉回。
 *
 * @param {{x,y,vx,vy,faceX,faceY,dashTicks,dashCd}} entity 會被直接修改
 * @param {{moveX:number,moveY:number,skill:number}} input moveX/moveY 每軸 -1 / 0 / 1
 * @param {number} dt 秒
 */
export function stepEntity(entity, input, dt) {
  const dash = SKILLS[DASH_INDEX];
  if (entity.dashCd > 0) entity.dashCd--;

  // 有在移動就更新面向（技能和衝刺的方向）
  if (input.moveX !== 0 || input.moveY !== 0) {
    entity.faceX = input.moveX;
    entity.faceY = input.moveY;
  }

  // 開始衝刺：方向 = 面向（有推搖桿時就是推的方向）
  if (dash && input.skill === DASH_INDEX + 1 && entity.dashCd === 0 && entity.dashTicks === 0) {
    entity.dashTicks = dash.ticks;
    entity.dashCd = dash.cooldownTicks;
  }

  let vx, vy;
  if (entity.dashTicks > 0) {
    entity.dashTicks--;
    const len = Math.hypot(entity.faceX, entity.faceY) || 1;
    vx = (entity.faceX / len) * dash.speed;
    vy = (entity.faceY / len) * dash.speed;
  } else {
    let dirX = input.moveX;
    let dirY = input.moveY;
    // 斜走時正規化，避免比直走還快
    if (dirX !== 0 && dirY !== 0) {
      dirX *= Math.SQRT1_2;
      dirY *= Math.SQRT1_2;
    }
    vx = dirX * PLAYER_SPEED;
    vy = dirY * PLAYER_SPEED;
  }

  const x = entity.x + vx * dt;
  const y = entity.y + vy * dt;
  const clampedX = clamp(x, PLAYER_HALF, ARENA_WIDTH - PLAYER_HALF);
  const clampedY = clamp(y, PLAYER_HALF, ARENA_HEIGHT - PLAYER_HALF);

  // 撞牆時速度也歸零，讓預測重播和伺服器一致
  if (clampedX !== x) vx = 0;
  if (clampedY !== y) vy = 0;

  // 障礙物：X、Y 分開檢查，斜著撞到柱子時可以沿著邊滑過去。
  // 撞到時貼齊柱子邊緣，不會停在半空中
  let nextX = clampedX;
  let nextY = clampedY;
  const hitX = obstacleHitByBox(nextX, entity.y, PLAYER_HALF);
  if (hitX) {
    nextX = vx > 0 ? hitX.left - PLAYER_HALF : hitX.right + PLAYER_HALF;
    vx = 0;
  }
  const hitY = obstacleHitByBox(nextX, nextY, PLAYER_HALF);
  if (hitY) {
    nextY = vy > 0 ? hitY.top - PLAYER_HALF : hitY.bottom + PLAYER_HALF;
    vy = 0;
  }

  entity.x = nextX;
  entity.y = nextY;
  entity.vx = vx;
  entity.vy = vy;
}
