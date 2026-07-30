## 快速登入連結（QuickLogin）

**執行順序**：路由守衛管線第 **6** 棒。

**觸發**：網址帶快速登入 token 時（例如簡訊或 email 裡的一鍵登入連結）。

### 步驟

1. **網址沒有快速登入 token 就放行** `src/router/guards/quickLogin.ts:6`

2. **用 token 換取登入狀態** `src/router/guards/quickLogin.ts:8`
   token 先做 URL 解碼再送出，連同機構代碼一起。

3. **立刻補抓使用者資料** `src/router/guards/quickLogin.ts:12`
   快速登入拿到的只是 token，沒有使用者資訊。這一步必須在同一個守衛內完成，
   否則後面的 AuthGate 會因為「有 token 但沒有 userData」而多跑一次。

4. **把 token 從網址上移除再重新導航** `src/router/guards/quickLogin.ts:15`
   帶 `replace: true`。這一步是安全考量：一次性登入 token 不該留在瀏覽器歷史、
   分享連結或 referrer 裡。

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `POST /api/v1/quickLogin` | 用一次性 token 換取登入狀態（try 保護內） | `src/api/login.ts:42` |
| 認證 Store 的 token | 寫入 | `src/router/guards/quickLogin.ts:8` |
| 認證 Store 的使用者資料與權限 | 寫入 | `src/router/guards/quickLogin.ts:12` |
| localStorage | 寫入（取回使用者資料後同步語系偏好） | `src/utils/composables/useLocalStorage.ts:9` |
| 網址 | 移除快速登入參數（`replace`，不留歷史） | `src/router/guards/quickLogin.ts:15` |

### 異常與補償

**沒有 try／catch。** 換取失敗會讓導航被拒絕，錯誤由全域 API 回應攔截器處理。
需要注意的副作用：**失敗時網址上的一次性 token 不會被清掉**，因為清除是在成功路徑上。

### 未追蹤的部分

`getUserDataHandler` 取回使用者資料的端點未在本鏈展開（該節點已在本鏈他處展開，
故以參照取代）。
