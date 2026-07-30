## 訪客自動登入（GuestLogin）

**執行順序**：路由守衛管線第 **5** 棒。

**觸發**：每一次路由切換，但只有標記為允許訪客的頁面才動作。

### 步驟

1. **只在「頁面允許訪客」且「目前沒有 token」時動作** `src/router/guards/guestLogin.ts:6`
   頁面是否允許訪客由路由的 `meta.guestLogin` 決定。已登入者不受影響——已有 token
   就放行，不會被降級成訪客身分。

2. **取得訪客身分的 token** `src/router/guards/guestLogin.ts:7`
   讓使用者不必註冊就能看到指定的公開內容。

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| 認證 Store 的 token | 寫入（訪客身分） | `src/router/guards/guestLogin.ts:7` |

### 異常與補償

**沒有 try／catch。** 訪客登入失敗會讓這次導航直接被拒絕，錯誤交由全域的 API 回應
攔截器處理（見「API 攔截器 — 回應錯誤」）。

### 未追蹤的部分

`guestLoginHandler` 內實際呼叫的後端端點未在本鏈展開。
