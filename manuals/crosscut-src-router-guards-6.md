## 權限判定（Permission）

**執行順序**：路由守衛管線第 **9** 棒，緊接在 AuthGate 之後——必須先確定身分，才能談權限。

**觸發**：每一次路由切換。

### 步驟

1. **未登入就放行** `src/router/guards/permission.ts:8`
   權限判定對未登入者沒有意義，該不該擋已由 AuthGate 決定。

2. **頁面沒有宣告所需權限就直接標記為「有權限」** `src/router/guards/permission.ts:10`
   注意這裡的預設方向：**沒宣告 = 通過**。所以新頁面若忘記在路由 `meta.permissions`
   宣告權限，會對所有登入者開放。這是這個守衛最需要留意的一點。

3. **有宣告則實際比對使用者權限** `src/router/guards/permission.ts:13`
   結果寫進 `to.meta._hasPermission`。

**這個守衛不會攔下導航。** 它只把判定結果掛在路由 meta 上，實際的擋人或顯示無權限
畫面由導航後的處理（`applyPostNav`）負責。這個分工讓「無權限」可以呈現成頁面內容
而不是一次跳轉。

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| 路由 meta 的 `_hasPermission` | 寫入（供導航後讀取） | `src/router/guards/permission.ts:13` |

沒有任何後端互動。權限比對是純前端運算，資料來源是登入時取回的權限清單。

### 異常與補償

沒有可失敗的操作。

### 未追蹤的部分

`checkPermissions` 的比對規則位於共用層 `src/utils/functions/execute.ts:26-32`，
它只取用認證 Store 的權限資料 `src/utils/functions/execute.ts:28`，實際比對邏輯
未在本鏈展開。
