## 補回機構代碼（ResetOrgCode）

**執行順序**：路由守衛管線最後一棒（第 **12**）。

**觸發**：每一次路由切換。

### 步驟

1. **網址已經帶 `?c=` 就放行** `src/router/guards/resetOrgCode.ts:6`

2. **使用者沒有所屬機構就放行** `src/router/guards/resetOrgCode.ts:8`
   未登入或無機構歸屬時無事可做。

3. **頁面明確不需要機構代碼就放行** `src/router/guards/resetOrgCode.ts:9`
   由路由 `meta.shouldResetOrgCode === false` 指定。注意判斷是 `=== false`，
   所以沒宣告的頁面**會**被補上機構代碼。

4. **否則把使用者的所屬機構補到網址上** `src/router/guards/resetOrgCode.ts:11`

這棒排在最後是有道理的：前面所有守衛都可能改寫導航目標，等它們都決定完了，
才在最終的網址上補齊機構代碼。這也讓使用者複製出去的連結自帶機構資訊。

### 資料變化

無資料寫入，只改變導航目標的 query。

### 異常與補償

沒有可失敗的操作。
