# 獨立結算流程與統一呼叫入口

2026-11-14。執行入口與獨立結算已寫入源碼。本次只收尾原有 12 個檔案、直接依賴的部署設定與架構文件，不再擴大重構。

## 已落實的責任

- `runtime/execution.ts` 是聊天、群聊及 Bot 互叫的共同執行入口，持有真正的 SDK／工具執行與取消資源。
- `runtime/settlement.ts` 是正式訊息、串流事件、等待與終態的唯一寫入擁有者；結果與終態在同一交易結算。
- `runtime/types.ts` 固定契約，`runtime/routes.ts` 只承接已認證的 HTTP、快照、SSE 與 Stop。
- 群聊保存真正作者；Bot 互叫使用實際 parentRunId；人手答覆恢復原 runId／toolCallId。狀態按 run／Bot 分開保存。
- 模型 adapter 只產生模型片段，全部應用工具由同一服務端工具迴圈執行；舊回呼執行器已移除。
- 舊 runner／thread-store、queue／claim／lease、relay、泛用審批與背景工作不再接入核心。日程舊引擎亦已移除，不宣稱日程可用。

## 保留能力

最優先保留瀏覽器／電腦的原生登入狀態、操作、畫面及人手接管。保留正式 Bot roster、選擇／建立／切換、同伴呼叫、手動郵件／日曆、文件、帳號與工作目錄隔離。

完整模組與資料流程見 `openbot/docs/architecture.md`。狗屎形狀庫只記錄代碼形狀；實作進度留在此處及 `tasks/todo.md`。

## 本次交付邊界

不新增、修改或執行測試，不跑 lint、typecheck 或其他檢查器。建置使用已讀過的前端成品入口，避開總 build 內的型別檢查。建置、應用及實際運作最多兩輪，任何建置或啟動失敗亦計入該輪；第二輪仍有問題即停止匯報。

收尾後 commit 並 push，訊息包含 `[skip ci]`，避免間接觸發未授權檢查。實際執行結果記於 `tasks/todo.md`，不以源碼讀回冒稱運行成功。
