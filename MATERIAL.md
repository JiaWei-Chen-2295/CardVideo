# 五月天物料：两张图，两个用途

> 这份文档处理一个 **已经绕过一次弯** 的地方，所以第一件事是把两张图彻底分开。

---

## 0. 别把这两张图搞混

|  | **印刷物料** | **AR 取景框** |
|---|---|---|
| 是什么 | 演唱会那一帧照片**本身** | GPT image 生成的装饰外框 |
| 用在哪 | 打印出来，被手机摄像头扫 | AR 页面**浮在实时摄像头画面之上** |
| 中间要不要抠空 | —— | **要**，否则不透明的底色会把摄像头画面整个盖住 |
| 要不要额外的边框 | **不要** | 这就是边框 |
| 落到哪个文件 | `/create` 页面上传的"照片" | `public/frames/viewfinder.webp` |

**踩过的坑**：一开始把这两件事合成了一件——把框和照片拼成一张成品图当追踪目标。方向是错的。
框不是目标图的一部分，它是 **AR 页面的一层 UI**。

---

## 1. 实测：那张照片本身就能扫，不需要边框

把 `data/fixtures/mmexport1779000933153_1786544416282edit.jpg`（4096×1848，2.2165:1）
喂给 **mind-ar 的真实特征提取器**（和 App 上传预检用的是同一个 `extract.js`）：

| 目标图 | 短边 256px 特征点 | 短边 128px 特征点 | 判定（阈值 8） |
|---|---|---|---|
| **原图不裁** | 82 | **64** | ✅ 8 倍余量 |
| 裁底 8% | 86 | 69 | ✅ |
| 裁底 12% | 92 | 73 | ✅ |
| 裁底 18% | 98 | 75 | ✅ |

**结论：这不是素图。** 鸟巢钢架网格提供了大量特征点，底部那片空旷广场只是在"稀释"。
所以**印刷物料就是这张照片，加边框反而只会抢走画面面积。**

> ⚠️ 这个结论**只对这张照片成立**。换一张构图平淡的（纯天空、大面积虚化）就得重跑实测。

---

## 2. 照片处理：只抹水印，绝对不要裁

水印 `HUAWEI Mate80 | XMAGE` 的实测位置（连通域自动定位，不是目测）：

| | x | y |
|---|---|---|
| 文字 `HUAWEI Mate80 \| XMAGE` | 4.8% – 20.3% | 93.9% – 95.9% |
| 左侧圆标 | 2.1% – 3.1% | 95.2% – 96.7% |

只占画面右下角一个小角。而两位主体的下半身**本来就被原图边缘切掉了**（原图就是"切到胯部"的构图）。

- ✅ **抹掉水印**，然后原图比例不裁。
- ❌ **不要裁底去水印** —— 裁 9% 才盖得住，会把两个人从"切到胯"变成"切到腰"，构图明显变差。

**推荐**：用修图 App 的内容识别填充 / 消除笔，两秒搞定，效果最好。

**命令行兜底**（实测可用，一行）：

```powershell
# 框按上面的实测位置加内边距算出：x=61 y=1713 w=795 h=96（原图 4096x1848）
ffmpeg -i "data\fixtures\mmexport1779000933153_1786544416282edit.jpg" -vf "delogo=x=61:y=1713:w=795:h=96" -q:v 2 "data\fixtures\mmexport-clean.jpg"
```

水印会完全消失，代价是左下角那块地面砖缝被轻微平滑 —— 比水印好得多，明信片尺寸下基本看不出来。
本仓库已经生成好一份可直接上传的 `data/fixtures/mmexport-clean.jpg`。

> **为什么不是简单的颜色阈值？** 试过，不行：右侧地砖同样有大量低饱和亮像素（实测 rgb≈204,201,196），
> 阈值一放宽就整片误判。水印笔画是几百到几千像素的**大块连通域**，地砖反光是**碎点**——形状才是判据。

---

## 3. AR 取景框：竖版提示词

### 3.1 为什么必须重新生成竖版

你手上那张是 **1536×1024 横版**。手机是竖屏，用 `object-fit: cover` 铺满时，横版素材要按
**高度**放大：

```
素材 1536×1024  →  390×844 的竖屏
放大倍率 = 844/1024 = 0.824
渲染后宽 = 1536 × 0.824 = 1266px，屏幕只有 390px
=> 左右各裁掉 531px，占总宽 34.6%
```

**鸟巢钢架和荧光棒海会被裁掉三分之一。** 所以要用 **1024×1536** 重新生成。

### 3.2 尺寸怎么定的（这次是有依据的，不是拍的）

竖屏 `cover` 会裁掉素材左右各约 **15.3%**（按 390×844 算，更长的手机更多，20:9 时约 16.2%）。
所以**左右边带必须比它宽**，否则侧面整条被裁光，外框退化成只有上下两条。

取 **左右边带 22%**，于是：

| | 素材上 | 竖屏上实际可见 |
|---|---|---|
| 左右边带 | 22% 宽（225px） | 裁掉 157px 后还剩 68px → 屏幕上约 **37px** |
| 上下边带 | 13% 高（200px） | 完全不裁 → 屏幕上约 **109px** |
| 中间透明区 | 56% × 74% | 屏幕上约 **81% 宽 × 74% 高**（实时画面从这块透出来） |

侧边 37px + 上下 109px，这才读得出"四面都有框"。

### 3.3 主提示词（复制这段，English）

> 尺寸选 **1024 × 1536（竖向 2:3）**。英文约束的服从度明显更高。

```
Create a 2:3 PORTRAIT decorative overlay frame for a phone camera viewfinder. It will be laid on
top of a live camera feed, so the middle must be a plain flat panel that gets cut out to
transparent later.

GEOMETRY
The artwork is a ring of border art around a completely EMPTY rectangular window in the centre.
The empty window occupies the central 56% of the canvas width and 74% of the canvas height,
perfectly centred. This leaves a border band of about 22% of the canvas width at the left and at
the right, and about 13% of the canvas height at the top and at the bottom. The border art bleeds
to all four edges of the canvas.
The empty window must be a plain, absolutely uniform, perfectly flat near-black deep navy panel,
hex #050d24 -- no texture, no grain, no glow, no gradient, no vignette, no objects and no pattern
inside it. Any variation inside that panel becomes visible dirt, because the panel is deleted
afterwards.

SAFE ZONE
On a phone the far left and far right of this artwork get cropped away, so the left and right
bands must be a continuous texture of light streaks with no single recognisable object and
nothing that reads as broken when cut. The top and bottom bands are never cropped -- that is
where the strongest design belongs.

BORDER ART
Night-time stadium concert atmosphere. Base colour deep indigo and midnight blue, roughly
#0a1230 to #16264f. Inside the border band, build a rich hand-painted organic collage of:
- woven steel lattice arcs inspired by a bird's-nest shaped stadium roof, glowing warm amber and
  off-white, concentrated along the top edge
- a dense field of blue glow sticks across the bottom edge, with long-exposure light trails
  arcing up the left and right sides in electric cyan and cobalt
- a soft haze of stage spotlight beams and gentle lens flare, warm orange entering from one side
  and cool blue from the other
- fine irregular grain, like high-ISO night photography
- elegant viewfinder corner brackets at the four corners of the inner window: thin crisp light
  strokes with small tick marks, plus a hairline inner border. Draw them INSIDE the window so
  they sit against the live camera image.

STYLE
Cinematic, premium, printed-poster quality. Deep rich blacks but never pure #000000. High
micro-detail and painterly texture everywhere in the border band.

DO NOT INCLUDE
Any text, letters, numbers, words, captions, titles, logos, brand marks, watermarks or
signatures. No UI icons, no battery or signal indicators, no recording dots, no human faces. No
repetitive patterns, no tiling, no mirrored symmetry, no polka dots, no checkerboards, no uniform
geometric repeats.
```

### 3.4 出图后必做的一步

**GPT 经常会偷偷塞进伪文字。** 放大到 100% 挨个角落看一遍，看到类似文字的东西直接抹掉
——那些"字"一定是乱码，压在实时画面上会非常廉价。

### 3.5 迭代变体（不满意时换 `BORDER ART` 段）

| 想要的感觉 | 替换为 |
|---|---|
| **星空版**（安静、高级） | `A deep night sky over a stadium: a dense irregular star field, a faint milky-way band, a low horizon glow of warm amber stage light behind a silhouetted roof structure. Sparse, delicate, hand-painted.` |
| **胶片版**（复古、有质感） | `A vintage 35mm film aesthetic: film sprocket perforations along the top and bottom edges, warm halation glow bleeding out of bright areas, dust and scratch marks, subtle chemical staining, muted teal and amber colour grading.` |
| **泼墨版**（更艺术、更抽象） | `An expressive ink-wash painting: sweeping cobalt and cyan brush strokes over a deep indigo ground, wet bleeding edges, ink splatter, dry-brush texture, with a few warm amber accents like stage lights.` |
| **光轨版**（最贴"现场"） | `Long-exposure light trails from thousands of blue glow sticks, arcing horizontally through the border band, with warm amber stadium floodlights blooming behind them and a soft atmospheric haze.` |

---

## 4. 安装取景框（一条命令）

```powershell
node scripts\frame-alpha.mjs --in "data\ChatGPT Image ....png" --out "public\frames\viewfinder"
```

它做四件事，**任何一件不对都会出声**：

1. **定位中间那块纯色窗口**（从正中心往外走，走到颜色不再等于中心像素为止）。
   这正是提示词强制"纯色填充"的原因：检测靠的就是这个性质。
2. **只把窗口内的纯底色抠成透明**。
   ⚠️ **不是整块矩形抠掉** —— 四角白线是画在窗口**内部**的，整块抠会把它们一起删掉。
   而白线正是最"取景框"的元素，本来就该浮在实时画面上。这是第一版脚本犯的错。
3. **预测竖屏裁切**：用 390×844 算出左右各裁多少，并检查左右边带会不会被整条裁光。
4. **输出 WebP**（约 124KB，PNG 是 1.96MB，差 16 倍 —— 它和 4MB 的 AR 包在同一条关键路径上）
   并打印"透明区在屏幕上占多少"。

退出码 **2 表示有警告**：底色不够纯、边带会被裁光、窗口贴到画布边缘……都必须先处理，
别把有问题的素材用上去。

> 目前 `public/frames/viewfinder.webp` 里装的是**横版占位素材**（用你已生成的那张抠的）。
> 它能让整条链路现在就跑起来，但左右边带会被裁光——脚本会这么警告。竖版生成后重跑一次即可覆盖。

---

## 5. 上传与发布

1. 打开 `/create`：① 照片选**抹掉水印后的演唱会照片**，② 视频选要播的 MP4（H.264），③ 标题填歌名/场次。
2. 拿到分享链接后，**把 `/c/` 换成 `/m/`**：
   - `/c/<id>` = 通用落地页（有"请把照片打印出来"那套说明）
   - `/m/<id>` = **极简物料页**：只有画面 +「把镜头对准卡片」+ 一个按钮
3. 二维码指向 **`/m/<id>`**，印在卡片背面。
4. 二维码下面加一行小字：**「打不开摄像头？点右上角 · 在浏览器中打开」**
   —— iOS 微信内置浏览器不给网页摄像头权限，这是唯一绕不过去的坑。

---

## 6. 真机验收（我做不了，必须你来）

沙箱里起不了浏览器（Chromium 挂在 mojo 命名管道限制上），所以**页面渲染效果我无法验证**。

- [ ] 手机打开 `/m/<id>`，看到星空背景 + 发光卡片 + 「把镜头对准卡片」
- [ ] 点「进入现场」，物料版开场只有标题 + 一句引导 + 按钮（**不该**出现"打印出来"那三步）
- [ ] **四周取景框完整**：上下边带明显，左右各有一条约 37px 的侧边，四角白线压在实时画面上
- [ ] 识别成功、视频升起：注意视频屏会从取景框边带**下面**穿过（这是刻意的，真取景框就是这样）
- [ ] 卡片彩打，室内照明，25–45cm：**2 秒内识别成功**
- [ ] 手抖丢失追踪后能自动恢复（0.8 秒宽限内不抽搐）
- [ ] 微信里扫码 → 提示用浏览器打开 → 系统浏览器里能正常进 AR
