import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 分析結果的**表示法版本**。閉環用它判斷該走日常圈還是升版圈。
 *
 * 這不是套件版本號，而是「同一份程式碼會不會產出同樣的 JSON」的宣告。
 * 改了會影響輸出的東西就要 +1：entry ID 方案、副作用分類、邊界判定、
 * 封包格式。改文件、修效能、加測試都不算。
 *
 * 為什麼不用 package.json 的版本或 git hash：前者要記得手動 bump，忘了就等於
 * 沒有；後者每個 commit 都變，連改個錯字都會觸發全量重生。這個常數是刻意的
 * 人為宣告——**它變了，就代表舊 baseline 不能拿來 diff**。
 *
 * **跟 package.json 的版本分工**：分析器只要改到輸出就 bump package.json，
 * 閉環用它判斷「同一個 commit 要不要重跑」（`loop.ts` 的早退判準）；只有在
 * 「舊 baseline 逐條比對會得到滿江紅」時才動這個常數。純增量的擴充兩者不同——
 * 實測加上點號 handler 與推播偵測後，舊 baseline 比得動且結果正確
 * （1932 沒變、11 改、30 新增），那種情況 bump 這裡只會讓閉環白卡一輪。
 *
 * 版本紀錄：
 * - 1：初版。entry ID 為 `檔案:行號:標籤:事件`
 * - 2：entry ID 改為語意錨點（不含行號），新增 legacyEntryId 供一次性遷移
 * - 3：每條鏈新增 sourceHash，供 diff 偵測「結構沒變但主體改了」
 * - 4：sourceHash 不再含檔案路徑，純改名才不會被誤判成主體變更
 */
export const REPRESENTATION_VERSION = 4

let cachedVersion: string | null = null

/** package.json 的版本號，寫進分析結果供人辨識（判斷依據仍是 REPRESENTATION_VERSION）。 */
export function packageVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  // src/version.ts 與 dist/version.js 都在專案根的下一層，往上一層即 package.json
  const here = path.dirname(fileURLToPath(import.meta.url))
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: string }
    cachedVersion = pkg.version ?? '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/** 目標 repo 的 git 狀態。閉環的早退比對依據。 */
export interface TargetRevision {
  /** HEAD 的 commit hash；目標不是 git repo 時為 null */
  commit: string | null
  /**
   * 工作目錄有未提交的變動。
   *
   * dirty 的樹產出的 baseline 不可重現——下次即使 commit 沒變，
   * 分析結果也可能不同，所以閉環不該把它當成可信的比對基準。
   */
  dirty: boolean
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export function readTargetRevision(repoRoot: string): TargetRevision {
  const commit = git(repoRoot, ['rev-parse', 'HEAD'])
  if (commit === null) return { commit: null, dirty: false }
  return { commit, dirty: (git(repoRoot, ['status', '--porcelain']) ?? '') !== '' }
}

/**
 * 兩個 commit 之間的檔案改名對照（舊路徑 → 新路徑）。
 *
 * entry ID 含檔案路徑，所以搬一個資料夾會讓底下每條流程都變成
 * removed ＋ added——實際上它們只是換了位置，敘述完全還能用。
 * 有了這張表，diff 先把 baseline 的 ID 換成新路徑再比對，於是落在 moved，
 * 走 0-token 的機械改寫。
 *
 * 取不到（不是 git repo、commit 不存在、淺層 clone 沒有歷史）就回空表，
 * 退回「改名視為 removed＋added」的保守行為，不會出錯只是比較浪費。
 */
export function detectRenames(repoRoot: string, from: string, to: string): Map<string, string> {
  const out = git(repoRoot, ['diff', '--name-status', '--diff-filter=R', '-M', from, to])
  const renames = new Map<string, string>()
  if (!out) return renames
  for (const line of out.split('\n')) {
    const [status, oldPath, newPath] = line.split('\t')
    if (!status?.startsWith('R') || !oldPath || !newPath) continue
    renames.set(oldPath, newPath)
  }
  return renames
}
