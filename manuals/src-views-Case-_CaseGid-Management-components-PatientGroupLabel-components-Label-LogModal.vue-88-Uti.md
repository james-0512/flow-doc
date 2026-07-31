## 檢視個案標籤異動紀錄

**觸發**：個案管理頁的標籤異動紀錄視窗開啟時自動執行（視窗的 show 事件）
`src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:88`

### 步驟

1. **初始化視窗並掛上載入狀態**
   `src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:45-49`

2. **查詢該個案的標籤異動紀錄**
   `src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:53-71`
   沒有群組 ID 就直接返回、不打 API。有的話帶 patientGroupId 與 caseGid 呼叫
   `getLabelLog` `src/api/case.ts:79-85`
   → `GET /api/v1/cm/label/log`（讀取）`src/api/case.ts:82`。

3. **整理成畫面用的紀錄清單**
   `src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:53-71`
   每筆取操作類型、標籤名稱、操作者，時間以 dayjs 格式化後顯示。

4. **解除載入狀態**
   `src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:48`

### 序列圖

```mermaid
sequenceDiagram
    participant U as 使用者
    participant M as 標籤異動紀錄視窗
    participant API as 後端

    U->>M: 開啟視窗
    M->>M: 掛上載入狀態
    alt 有群組 ID
        M->>API: GET /api/v1/cm/label/log
        API-->>M: 異動紀錄清單
        M->>M: 格式化後顯示
    else 沒有群組 ID
        M->>M: 不查詢
    end
    M->>M: 解除載入狀態
```

### 資料變化

| 對象 | 動作 | 位置 |
|---|---|---|
| `GET /api/v1/cm/label/log` | 唯讀 | `src/api/case.ts:82` |
| 載入 Store | 掛上後解除 | `src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:48` |

不改變任何後端資料。

### 異常與補償

沒有 try／catch。查詢失敗由全域 API 回應攔截器顯示錯誤（見〈API 錯誤的全域處理〉）。
載入狀態的解除寫在 `await` 之後
`src/views/Case/_CaseGid/Management/components/PatientGroupLabel/components/Label/LogModal.vue:48`，
失敗時依賴攔截器最後的「清空載入狀態」安全網。

### 全域前置

這條流程的 API 呼叫會經過〈每個請求送出前〉注入授權與語言標頭，
失敗時由〈API 錯誤的全域處理〉接手。此處不重述。
