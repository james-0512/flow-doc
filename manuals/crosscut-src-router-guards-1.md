## Electron 版網址改寫（ElectronWebRedirect）

**執行順序**：路由守衛管線第 **2** 棒。

**觸發**：每一次路由切換。

### 步驟

1. **判斷是否為 Electron Web 環境** `src/router/guards/electronWebRedirect.ts:10`
   不是就直接放行。這個守衛只服務 Electron 的 web 版外殼。

2. **已在 `/electron` 底下就放行** `src/router/guards/electronWebRedirect.ts:11`

3. **否則把路徑改寫到 `/electron` 命名空間下** `src/router/guards/electronWebRedirect.ts:14`
   根路徑 `/` 導向 `/electron/dashboard`，其餘路徑加上 `/electron` 前綴。
   **query 與 hash 會保留**——登入頁的 `c`、`redirect` 等參數改寫後仍需帶著走，
   否則使用者會在改寫過程中失去機構與回跳目標。

### 資料變化

無。這個守衛只改變導航目標，不寫任何資料。

### 異常與補償

沒有可失敗的操作。
