// Share-link landing page.
//
// Deliberately a thin gate rather than an instant camera grab: the viewer needs to know
// the photo has to be PRINTED before pointing a camera at anything, and on iOS the audio
// unlock needs one real tap anyway. So this page's job is to (a) fetch the card,
// (b) show the photo so the viewer can confirm it matches what they were sent, and (c) hand
// off to the AR view on an explicit tap.

const cardId = location.pathname.split("/").filter(Boolean).pop();

const els = {
  loading: document.getElementById("loading"),
  error: document.getElementById("error"),
  card: document.getElementById("card"),
  title: document.getElementById("card-title"),
  photo: document.getElementById("card-photo"),
  start: document.getElementById("start"),
};

const fail = (message) => {
  els.loading.hidden = true;
  els.card.hidden = true;
  els.error.hidden = false;
  els.error.innerHTML = message;
};

(async () => {
  if (!/^[0-9A-Za-z]{12}$/.test(cardId ?? "")) {
    fail("这个链接看起来不完整，请向发给你的人重新要一次。");
    return;
  }

  try {
    const res = await fetch(`/api/cards/${encodeURIComponent(cardId)}`);
    if (res.status === 404) {
      fail("这张卡片不存在，可能已经被创建者删除了。");
      return;
    }
    if (!res.ok) {
      fail("加载卡片失败，请稍后重试。");
      return;
    }

    const card = await res.json();

    els.title.textContent = card.title || "一张 AR 照片";
    document.title = `${card.title || "AR 照片"} · CardVideo`;

    els.photo.src = card.photoUrl;
    els.photo.alt = card.title || "卡片照片";

    els.start.href = `/ar?card=${encodeURIComponent(cardId)}`;

    els.loading.hidden = true;
    els.card.hidden = false;
  } catch (err) {
    console.error("[card] load failed", err);
    fail("加载卡片失败：网络错误。");
  }
})();
