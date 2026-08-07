/**
 * 站台的自訂 VitePress 主題檔——只做一件事：讓 mermaid 圖能放大看。
 *
 * 複雜模組的序列圖動輒二十幾個訊息、寬到超出內文欄寬，mermaid 預設 `useMaxWidth`
 * 會把整張 svg 等比縮進欄寬裡，字就小到看不清。這裡加的是**點圖開全螢幕檢視**，
 * 在那層才做滾輪縮放／拖曳平移／雙指縮放。
 *
 * 為什麼是 overlay 而不是就地縮放：svg 是 `vitepress-plugin-mermaid` 的 Mermaid.vue
 * 用 `v-html` 塞進 `.mermaid` div 的，而它掛了 MutationObserver 監看
 * `documentElement` 的屬性——切換深色模式就整段重畫 innerHTML。任何塞進那個 div
 * 裡的工具列或包裝層都會被清掉，就地縮放等於跟元件的重繪搶 DOM。overlay 掛在
 * body 底下、只讀一份 clone，原本的 DOM 完全不動。
 *
 * 內容以字串常數保存（而非 templates/ 下的檔案）：`buildSite` 目前不碰 fs，
 * 純函式好測；站台的 package.json、config.mts 也都是這樣產的。
 */

/** `.vitepress/theme/index.ts` */
export const THEME_INDEX = `// 由 flow-doc site 產生，請勿手動編輯
import DefaultTheme from 'vitepress/theme'
import './diagram-zoom.css'
import { setupDiagramZoom } from './diagram-zoom'

export default {
  extends: DefaultTheme,
  enhanceApp() {
    // SSR 時沒有 document，只在瀏覽器端掛
    if (typeof document !== 'undefined') setupDiagramZoom()
  }
}
`

/**
 * `.vitepress/theme/diagram-zoom.ts`
 *
 * String.raw：內文有正則的 `\\s`，一般 template literal 會把不認識的轉義吃掉，
 * `[\\s,]` 會變成 `[s,]`。生成碼因此一律不用反引號與 `${}`，字串接起來就好。
 */
export const DIAGRAM_ZOOM_JS = String.raw`// 由 flow-doc site 產生，請勿手動編輯
//
// 點任一 mermaid 圖 → 全螢幕檢視：滾輪縮放、拖曳平移、雙指縮放、雙擊放大。
// 不動原本的 DOM（見 src/site-theme.ts 的說明），overlay 只吃一份 svg clone。

const MIN = 0.2
const MAX = 8
const FLOOR = 0.5 // 進場的下限：mermaid 的標籤約 24px，縮到一半還讀得到，再小就不行
const PAN_STEP = 80
const PAD = 24

let overlay = null
let viewport = null
let stage = null
let label = null
let sourceHost = null
let sourceWatch = null
let restoreFocus = null

let scale = 1
let tx = 0
let ty = 0

// 同時按住的指標（滑鼠只會有一個，觸控可能兩個以上）
const pointers = new Map()
let pinch = null
let moved = false

function clamp(s) {
  return Math.min(MAX, Math.max(MIN, s))
}

function apply() {
  stage.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')'
  label.textContent = Math.round(scale * 100) + '%'
}

/** 以 (cx, cy)（viewport 內座標）為定點縮放——滑鼠指到哪就放大哪 */
function zoomAt(next, cx, cy) {
  const s = clamp(next)
  const k = s / scale
  tx = cx - (cx - tx) * k
  ty = cy - (cy - ty) * k
  scale = s
  apply()
}

function zoomCenter(next) {
  const r = viewport.getBoundingClientRect()
  zoomAt(next, r.width / 2, r.height / 2)
}

/**
 * mermaid 想要的原始尺寸看 viewBox，不看畫面上的尺寸——畫面上那個已經被
 * useMaxWidth 縮過了，拿它當 100% 會永遠對不回原始字級。
 */
function natural(svg) {
  const vb = svg.getAttribute('viewBox')
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number)
    if (p.length === 4 && p[2] > 0 && p[3] > 0) return { w: p[2], h: p[3] }
  }
  const r = svg.getBoundingClientRect()
  return { w: r.width || 800, h: r.height || 600 }
}

/**
 * mode 'open'：進場用。以「看得清楚」為準，不是「看得完整」——
 * 寬度塞得進去就塞（上限 100%，放大過頭沒意義），但不低於 FLOOR：
 * 2900px 寬的流程圖 fit 寬度只有 23%，跟內文那張一樣糊，等於白開。
 * 低於 FLOOR 時改成靠左上角，讓使用者從頭讀、往右拖；要全景按「適合視窗」。
 * mode 'all'：「適合視窗」鈕用，整張塞進畫面。
 */
function layout(mode) {
  const r = viewport.getBoundingClientRect()
  const w = stage.offsetWidth || 1
  const h = stage.offsetHeight || 1
  const fitW = (r.width - PAD * 2) / w
  const fitH = (r.height - PAD * 2) / h
  scale = clamp(mode === 'all' ? Math.min(fitW, fitH) : Math.max(FLOOR, Math.min(1, fitW)))
  // 塞得下就居中，塞不下就對齊起點——居中會讓超寬的圖從中段開始，讀者找不到頭
  tx = w * scale + PAD * 2 <= r.width ? (r.width - w * scale) / 2 : PAD
  ty = h * scale + PAD * 2 <= r.height ? (r.height - h * scale) / 2 : PAD
  apply()
}

function midpoint() {
  const list = [...pointers.values()]
  const r = viewport.getBoundingClientRect()
  return {
    x: (list[0].x + list[1].x) / 2 - r.left,
    y: (list[0].y + list[1].y) / 2 - r.top,
    d: Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y)
  }
}

function build() {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'fdz-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', '圖表放大檢視')
  overlay.tabIndex = -1
  overlay.innerHTML = [
    '<div class="fdz-bar">',
    '<button type="button" data-fdz="out" aria-label="縮小">−</button>',
    '<span class="fdz-scale">100%</span>',
    '<button type="button" data-fdz="in" aria-label="放大">＋</button>',
    '<button type="button" data-fdz="fit">適合視窗</button>',
    '<button type="button" data-fdz="one">1:1</button>',
    '<span class="fdz-spacer"></span>',
    '<button type="button" data-fdz="close">關閉 (Esc)</button>',
    '</div>',
    '<div class="fdz-viewport">',
    '<div class="fdz-stage"></div>',
    '<p class="fdz-hint">滾輪縮放 · 拖曳平移 · 雙擊放大 · Esc 關閉</p>',
    '</div>'
  ].join('')
  document.body.appendChild(overlay)

  viewport = overlay.querySelector('.fdz-viewport')
  stage = overlay.querySelector('.fdz-stage')
  label = overlay.querySelector('.fdz-scale')

  overlay.querySelector('.fdz-bar').addEventListener('click', e => {
    const btn = e.target.closest('button[data-fdz]')
    if (!btn) return
    const act = btn.getAttribute('data-fdz')
    if (act === 'in') zoomCenter(scale * 1.3)
    else if (act === 'out') zoomCenter(scale / 1.3)
    else if (act === 'fit') layout('all')
    else if (act === 'one') zoomCenter(1)
    else close()
  })

  viewport.addEventListener(
    'wheel',
    e => {
      e.preventDefault()
      const r = viewport.getBoundingClientRect()
      // deltaMode 1 是「行」，各家瀏覽器一行的量差很多，統一折成約 16px
      const d = e.deltaY * (e.deltaMode === 1 ? 16 : 1)
      zoomAt(scale * Math.exp(-d * 0.0015), e.clientX - r.left, e.clientY - r.top)
    },
    { passive: false }
  )

  viewport.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    moved = false
    if (pointers.size === 2) {
      const m = midpoint()
      pinch = { d: m.d, scale: scale }
    }
    viewport.classList.add('is-panning')
    // 捕獲放最後、且容許失敗：拖到工具列上還要繼續收到 pointermove，
    // 但這一步若丟例外（指標已經不在了）不該讓上面的手勢狀態沒設成
    try {
      viewport.setPointerCapture(e.pointerId)
    } catch {
      /* 沒捕獲就退回一般冒泡，功能不受影響 */
    }
  })

  viewport.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId)
    if (!prev) return
    const dx = e.clientX - prev.x
    const dy = e.clientY - prev.y
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size >= 2 && pinch) {
      const m = midpoint()
      if (m.d > 0) zoomAt(pinch.scale * (m.d / pinch.d), m.x, m.y)
    } else {
      tx += dx
      ty += dy
      apply()
    }
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true
  })

  for (const type of ['pointerup', 'pointercancel']) {
    viewport.addEventListener(type, e => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) pinch = null
      if (pointers.size === 0) viewport.classList.remove('is-panning')
    })
  }

  viewport.addEventListener('dblclick', e => {
    e.preventDefault()
    if (scale >= 4) {
      layout('open')
      return
    }
    const r = viewport.getBoundingClientRect()
    zoomAt(scale * 2, e.clientX - r.left, e.clientY - r.top)
  })

  // 點圖外的空白處關閉；拖曳收尾時的 click 不算
  viewport.addEventListener('click', e => {
    if (e.target === viewport && !moved) close()
  })

  overlay.addEventListener('keydown', e => {
    const key = e.key
    if (key === 'Escape') close()
    else if (key === '+' || key === '=') zoomCenter(scale * 1.3)
    else if (key === '-' || key === '_') zoomCenter(scale / 1.3)
    else if (key === '0') layout('all')
    else if (key === '1') zoomCenter(1)
    else if (key === 'ArrowLeft') tx += PAN_STEP
    else if (key === 'ArrowRight') tx -= PAN_STEP
    else if (key === 'ArrowUp') ty += PAN_STEP
    else if (key === 'ArrowDown') ty -= PAN_STEP
    else return
    e.preventDefault()
    if (key.startsWith('Arrow')) apply()
  })
}

/** 把 host 裡的 svg 複製進舞台。縮放狀態不動——重繪（換深色模式）時要留在原處 */
function mount(host) {
  const svg = host.querySelector('svg')
  if (!svg) return false
  const size = natural(svg)

  // mermaid 把樣式塞在 svg 內的 <style>，選擇器一律以這張圖的 id 開頭
  // （#mermaid-6 .edgeLabel{...}），箭頭的 marker id 也以它為前綴。
  // 直接 clone 會有兩個同 id 的節點；把根節點的 id 拿掉又會讓那些規則全部失配——
  // 字體、顏色、線寬會默默掉回頁面預設值，圖看起來就不是原來那張。
  // 所以連內部參照一起字串換名，兩個問題一次解決。
  const id = svg.getAttribute('id')
  const html = svg.outerHTML
  stage.innerHTML = id ? html.split(id).join(id + '-fdz') : html

  const clone = stage.querySelector('svg')
  clone.removeAttribute('style') // 拿掉 useMaxWidth 的 max-width，縮放由 stage 的 transform 決定
  clone.setAttribute('width', String(size.w))
  clone.setAttribute('height', String(size.h))
  stage.style.width = size.w + 'px'
  stage.style.height = size.h + 'px'
  return true
}

function open(host) {
  build()
  if (!mount(host)) return
  sourceHost = host
  // 深色模式切換時 Mermaid.vue 會重畫這個 div 的 innerHTML，
  // 開著的檢視要跟著換一份，否則畫面上是舊主題的圖
  sourceWatch = new MutationObserver(() => mount(host))
  sourceWatch.observe(host, { childList: true })

  restoreFocus = document.activeElement
  overlay.classList.add('is-open')
  document.documentElement.classList.add('fdz-lock')
  overlay.focus()
  layout('open') // 量尺寸要在 overlay 顯示之後
}

function close() {
  if (!overlay || !overlay.classList.contains('is-open')) return
  overlay.classList.remove('is-open')
  document.documentElement.classList.remove('fdz-lock')
  stage.replaceChildren()
  pointers.clear()
  pinch = null
  if (sourceWatch) sourceWatch.disconnect()
  sourceWatch = null
  sourceHost = null
  if (restoreFocus && restoreFocus.focus) restoreFocus.focus()
  restoreFocus = null
}

export function setupDiagramZoom() {
  if (typeof document === 'undefined' || window.__fdzReady) return
  window.__fdzReady = true

  // 事件委派：圖是非同步畫出來的、換頁只換內容區，逐一綁監聽會一直漏
  document.addEventListener('click', e => {
    const t = e.target
    if (!(t instanceof Element) || t.closest('.fdz-overlay')) return
    // 圖裡的連結（mermaid 的 click 綁定）照常走
    if (t.closest('a')) return
    const host = t.closest('.vp-doc .mermaid')
    if (host) open(host)
  })

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const t = e.target
    if (!(t instanceof Element)) return
    const host = t.closest('.vp-doc .mermaid[data-fdz]')
    if (!host) return
    e.preventDefault()
    open(host)
  })

  // 補 tabindex：圖是 div + v-html，本身不可聚焦，鍵盤使用者進不去
  let queued = false
  const tag = () => {
    queued = false
    for (const el of document.querySelectorAll('.vp-doc .mermaid:not([data-fdz])')) {
      el.setAttribute('data-fdz', '')
      el.setAttribute('tabindex', '0')
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', '放大檢視圖表')
    }
  }
  // 用 setTimeout 而非 requestAnimationFrame 收斂：分頁在背景時 rAF 不跑，
  // 使用者切回來的第一次 Tab 就會發現圖聚焦不了
  new MutationObserver(() => {
    if (queued) return
    queued = true
    setTimeout(tag, 50)
  }).observe(document.body, { childList: true, subtree: true })
  tag()
}
`

/** `.vitepress/theme/diagram-zoom.css` */
export const DIAGRAM_ZOOM_CSS = String.raw`/* 由 flow-doc site 產生，請勿手動編輯 */

.vp-doc .mermaid {
  position: relative;
  cursor: zoom-in;
}
.vp-doc .mermaid:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 4px;
  border-radius: 4px;
}
/* 提示用 ::after 而非真的元素：div 的 innerHTML 會被 Mermaid.vue 重畫，
   偽元素不受影響 */
.vp-doc .mermaid::after {
  content: '點擊放大';
  position: absolute;
  right: 8px;
  bottom: 8px;
  padding: 2px 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 20px;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}
.vp-doc .mermaid:hover::after,
.vp-doc .mermaid:focus-visible::after {
  opacity: 1;
}

/* 檢視開著時鎖住背景捲動 */
.fdz-lock,
.fdz-lock body {
  overflow: hidden;
}

.fdz-overlay {
  position: fixed;
  inset: 0;
  z-index: 200; /* VitePress 自己最高到 local search 的 100 */
  display: none;
  flex-direction: column;
  background: var(--vp-c-bg);
}
.fdz-overlay.is-open {
  display: flex;
}
.fdz-overlay:focus {
  outline: none;
}

.fdz-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}
.fdz-bar button {
  min-width: 34px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
}
.fdz-bar button:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.fdz-scale {
  min-width: 52px;
  text-align: center;
  font-size: 13px;
  color: var(--vp-c-text-2);
  font-variant-numeric: tabular-nums;
}
.fdz-spacer {
  flex: 1;
}

.fdz-viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
  touch-action: none; /* 縮放與平移自己接手，交給瀏覽器會變成整頁縮放 */
}
.fdz-viewport.is-panning {
  cursor: grabbing;
}
.fdz-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}
.fdz-stage svg {
  display: block;
  max-width: none;
}

.fdz-hint {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  margin: 0;
  padding: 4px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}

@media (max-width: 640px) {
  .fdz-hint {
    display: none;
  }
}
`
