## 用 refresh token 續期（RefreshToken）

**執行順序**：路由守衛管線第 **7** 棒。

**觸發**：沒有 token 但頁面需要登入時。這是「使用者重開瀏覽器後仍然是登入狀態」
的實作位置。

### 步驟

1. **已有 token 就放行** `src/router/guards/refreshToken.ts:6`

2. **頁面不需要登入也放行** `src/router/guards/refreshToken.ts:7`
   注意預設值是 `true`——路由沒有明確標記 `requireAuth: false` 就視為需要登入。
   這個預設方向是對的：忘記標記會導致「多要求一次登入」，而不是「洩漏未授權頁面」。

3. **拿 localStorage 裡的機構代碼去續期** `src/router/guards/refreshToken.ts:9`
   機構代碼來自第 1 棒 PersistOrgCode 存下的值。續期成功就寫入新 token，
   使用者不會察覺自己曾經沒有 token。

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `POST /api/v1/login/refresh` | 以 refresh token 換取新的 access token（try 保護內） | `src/api/login.ts:91` |
| 認證 Store 的 token | 寫入（續期成功時） | `src/stores/auth.ts:186` |

### 異常與補償

續期失敗時，認證 Store 會**重設重試計數並導向登入頁** `src/stores/auth.ts:187`。
也就是說失敗處理不在守衛裡，而在 Store 的 action 內——這條流程的終點是登入頁，
而不是把錯誤丟給呼叫端。

### 未追蹤的部分

重試次數的上限邏輯（`resetRetryGetTokenCount` 對應的計數判斷）未在本鏈展開。
