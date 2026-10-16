/** 把文字轉成可安全放進 innerHTML 的字串（玩家名字等外部輸入一定要經過這裡） */
export const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
