// 物料页（/m/<id>）：给"手上已经拿着印刷物料的人"的极简入场屏。
//
// 和 /c/<id>（card.js）的区别只有一个，但这个区别决定了整个页面：
// card.js 的读者是"收到一张照片文件的人"，所以它必须解释"请把照片打印出来"。
// 这里的读者已经拿着印好的卡片 —— 那句话不但多余，还会让人怀疑自己是不是漏了一步。
//
// 所以这个页面不解释任何事，只做三件必须做的事：
//   1. 拿到卡片数据，把物料正面显示出来，让人确认"我手上这张就是它"；
//   2. 把 .mind 提前拉进 HTTP 缓存，让点击后的 AR 握手不用再等追踪文件；
//   3. 把「进入现场」指向带 theme=material 的 AR 页 —— 那一侧会换成极简文案。
//
// 刻意不做的事：不自动进摄像头。iOS 的音频解锁和摄像头授权都需要一次真实点击，
// 绕开它就是拿"扫出来了但没声音/权限框弹在空白页上"换几百毫秒。

const cardId = location.pathname.split("/").filter(Boolean).pop();

const els = {
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  content: document.getElementById("content"),
  title: document.getElementById("title"),
  shot: document.getElementById("shot"),
  enter: document.getElementById("enter"),
};

const fail = (message) => {
  els.loading.hidden = true;
  els.content.hidden = true;
  els.error.hidden = false;
  els.error.innerHTML = message;
};

/**
 * 预热追踪文件。
 *
 * .mind 只有 300KB 上下，却是 AR 侧启动路径上唯一"必须下完才能开始"的资源 ——
 * 视频可以边播边缓冲，它不行。在这里以最低优先级先取一份，点击时通常已经在缓存里，
 * 用户看到的就是"一点就进"而不是一条进度条。
 *
 * 视频刻意不预热：几十 MB，在移动数据下替用户决定花掉它是越界。
 */
function warmTracker(url) {
  if (!url) return;
  if (navigator.connection?.saveData) return; // 用户明确要求省流量时什么都不预取

  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "fetch";
  link.href = url;
  document.head.appendChild(link);
}

(async () => {
  // 分享码是 12 位 base62（server/lib/config.js）。先本地判一次，省掉一次必然 404 的请求。
  if (!/^[0-9A-Za-z]{12}$/.test(cardId ?? "")) {
    fail("这个链接看起来不完整，请重新扫一次二维码。");
    return;
  }

  try {
    const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}`);
    if (res.status === 404) {
      fail("这张卡片不存在，可能已经被创建者删除了。");
      return;
    }
    if (!res.ok) {
      fail("载入失败，请稍后重试。");
      return;
    }

    const card = await res.json();

    if (card.title) {
      els.title.textContent = card.title;
      els.title.hidden = false;
      document.title = `${card.title} · 现场`;
    }

    // 物料图就是识别目标本身 —— 用户要靠它确认手上这张卡对不对。
    els.shot.src = card.photoUrl;
    els.shot.alt = card.title || "物料卡片";

    els.enter.href = `/ar?card=${encodeURIComponent(cardId)}&theme=material`;

    warmTracker(card.mindUrl);

    els.loading.hidden = true;
    els.content.hidden = false;
  } catch (err) {
    console.error("[material] load failed", err);
    fail("载入失败：网络错误。");
  }
})();
