export interface SwaggerEndpoint {
  method: string
  url: string
  /** generated JSDoc 的 @summary，這個專案是中文，對手冊很有價值 */
  summary?: string
  tag?: string
}

const BLOCK_START = '/**'
const NAME = /@name\s+(\S+)/
const SUMMARY = /@summary\s+(.+?)\s*$/
const TAGS = /@tags\s+(.+?)\s*$/
const REQUEST = /@request\s+([A-Z]+):(\S+)/

/**
 * 線性掃描 swagger-typescript-api 產生的 client，建 `方法名 → 端點` 索引。
 *
 * 這個檔在目標專案有 94,926 行 / 1,245 支端點。刻意**不**把它載進 ts-morph——
 * 一次正則掃描就能拿到 method、URL 與中文 summary，付 Type Checker 的成本毫無意義。
 * 這也是 config 把它列為 STOP 的配套：不追進去，但仍知道呼叫了什麼。
 */
export function indexSwaggerApi(source: string): Map<string, SwaggerEndpoint> {
  const out = new Map<string, SwaggerEndpoint>()
  let name: string | undefined
  let summary: string | undefined
  let tag: string | undefined

  for (const line of source.split('\n')) {
    if (line.includes(BLOCK_START)) {
      name = summary = tag = undefined
      continue
    }
    const n = NAME.exec(line)
    if (n) {
      name = n[1]
      continue
    }
    const s = SUMMARY.exec(line)
    if (s) {
      summary = s[1]
      continue
    }
    const t = TAGS.exec(line)
    if (t) {
      tag = t[1]
      continue
    }
    const r = REQUEST.exec(line)
    if (r && name) {
      // JSDoc 的 @name 是 PascalCase，實際屬性名是 camelCase
      out.set(name.charAt(0).toLowerCase() + name.slice(1), {
        method: r[1]!,
        url: r[2]!,
        summary,
        tag
      })
    }
  }
  return out
}
