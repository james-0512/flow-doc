## OAuth 授權轉場（OAuthRedirect）

**執行順序**：路由守衛管線第 **10** 棒。

**觸發**：已登入且正在第三方授權流程中時。

### 步驟

1. **未登入就放行** `src/router/guards/oAuthRedirect.ts:6`
   授權需要先有身分，未登入時交給 AuthGate 處理。

2. **不在授權流程中就放行** `src/router/guards/oAuthRedirect.ts:7`
   判斷依據是網址上是否帶著 OAuth 流程的參數。

3. **已經在授權頁就放行** `src/router/guards/oAuthRedirect.ts:8`
   否則會無限重導。

4. **否則強制導向授權頁** `src/router/guards/oAuthRedirect.ts:10`
   query 整組帶過去，授權頁需要其中的 challenge 等參數。

這個守衛的作用是**不讓使用者在授權流程中途跑去別的頁面**。使用者從第三方應用被
導過來授權，登入完成後應該回到授權頁完成授權，而不是掉進本站首頁。

### 資料變化

無。這個守衛只改變導航目標。

### 異常與補償

沒有可失敗的操作。
