## 前往個案管理（先驗證個案權限）

**觸發**：預約清單某列點擊個案管理
`src/views/Appointment/AppointmentList/IndexView.vue:566`

### 步驟

1. **掛上載入狀態** `src/views/Appointment/AppointmentList/IndexView.vue:393`

2. **向後端確認操作者對該個案的權限** `src/api/appointment/appointmentList.ts:42`
   `POST /api/v1/appointment/check/caseAuth`。**這是查詢而非寫入**——用 POST 是為了
   把個案識別資訊放在 body，不暴露在網址上。

   這一步的意義是：預約清單看得到的個案，操作者未必有權限進入其個案管理。
   權限判斷放在後端而非前端 `meta.permissions`，因為它是**逐筆資料**的權限，
   不是頁面層級的權限——路由守衛的〈權限判定〉無法處理這種情況。

3. **解除載入狀態** `src/views/Appointment/AppointmentList/IndexView.vue:404`

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `POST /api/v1/appointment/check/caseAuth` | 唯讀，驗證個案權限 | `src/api/appointment/appointmentList.ts:42` |
| 載入 Store | 掛上後解除 | `src/views/Appointment/AppointmentList/IndexView.vue:404` |

不改變任何後端資料。

### 異常與補償

沒有 try／catch。驗證失敗（含無權限）由全域 API 回應攔截器顯示錯誤，
**使用者留在原頁**。這個設計讓「無權限」的呈現方式與其他 API 錯誤一致。

### 未追蹤的部分

驗證通過後的實際導航目標未出現在本鏈的副作用中——後續的頁面跳轉在此流程的
追蹤範圍之外。

### 全域前置

授權標頭注入與錯誤顯示見〈每個請求送出前〉與〈API 錯誤的全域處理〉；
頁面層級的權限判定見〈權限判定（Permission）〉。
