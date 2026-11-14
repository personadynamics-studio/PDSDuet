# 獨立結算方案收尾

2026-11-14。本次範圍固定為既有改動及架構文件，沒有追加功能或新一輪架構設計。

- [x] 唯一執行入口與獨立結算模組已寫入源碼。
- [x] 聊天、群聊與 Bot 互叫已接入；正式訊息由結算模組保存。
- [x] 已移除被替代的舊執行、寫入、佇列、租約、回呼及專用工作接線。
- [x] 已讀回剩餘 12 個檔案及直接接線；移除部署驗證對已刪除多副本設定的引用。
- [x] 架構文件與本計畫已改為現有實作。
- [x] 已用完授權的兩輪建置／啟動；第 2 輪仍有問題，已依指示停止，未進入實際對話。

此文件隨收尾改動提交；commit／push 的實際結果以本次對話的 Git 交付為準。

## 兩輪實際結果

1. 前端建置因新對話頁殘留 `seedMessage` 匯入而失敗。已刪除該匯入，直接顯示使用者實際送出的文字，沒有恢復自動開場。
2. 前端成品、`openduet-agent-computer:latest` 與 `openduet-supervisor:latest` 均建置成功。後端啟動在 `toolkit/src/native-agent.ts` 匯入 `@ai-sdk/openai` 時失敗：`Cannot find module '@ai-sdk/openai'`。該依賴已在 toolkit manifest 與 lock 宣告；本輪沒有再安裝依賴或重試解析。

已停止後續安裝、修復、建置、啟動與實際對話；沒有第三輪。這次啟動的 PostgreSQL 與 supervisor 已停止。舊的三個已停止電腦容器已移除，原有 profile／workspace 命名 volume 保留；新電腦映像已產生，但沒有完成 Bot 實際運作。

未建立、修改或執行測試；未執行 lint／typecheck。源碼已保存不代表建置或運行成功。狗屎形狀庫與 Slop 已在另一個 repo 推送完成，這裡不重複記錄其工作狀態。

## 依賴阻塞的追加授權與結果

使用者另行允許最多兩輪，只處理 `@ai-sdk/openai` 的安裝／解析阻塞，不擴大重構。

- 第 1／2 輪在 `openbot/` 執行 `bun install --frozen-lockfile --ignore-scripts`，成功安裝 58 個套件，沒有執行安裝腳本。
- 已讀回 toolkit 的實際連結與套件 metadata：`@ai-sdk/openai` 3.0.99 已安裝於工作區的 Bun 套件目錄。manifest、版本及 lockfile 均未變動，不需要修改模型或執行邏輯。
- 直接啟動正式後端後，原缺少 OpenAI 套件的錯誤不再出現；啟動改為停在 `SyntaxError: Export named 'MessageSchema' not found`。來源是 `server/src/runtime/routes.ts:1` 從 `@ag-ui/core` 匯入該符號。
- 這是另一個源碼匯入問題，依「只處理這個阻塞」的範圍未作修改，亦未使用第 2 輪重跑。沒有新增建置、啟動前端或進入實際對話。
- 本輪啟動的 PostgreSQL 與 supervisor 已停止。未跑測試、lint、typecheck，未新增或修改測試檔。

本次只更新這份紀錄與架構文件；實際依賴安裝位於不提交的 `node_modules`。commit／push 結果以本次對話的 Git 交付為準。

## MessageSchema 與同類阻塞收尾

使用者另行授權修正 MessageSchema 及後續同類阻塞，明確解除這類工作的兩輪限制；不擴大重構，仍禁止測試及子代理。

- `runtime/routes.ts` 改從安裝版本正式提供的 `@ag-ui/core/schemas` 匯入 `MessageSchema`，後端成功監聽 3001；既有前端成品成功監聽 3010。
- 實際對話先遇到 `messages[1]` 是字串的 SDK 錯誤。定位到 `settlement.ts` 將已序列化的字串直接綁定為 JSONB，Bun 會再編碼一次；所有該流程的 JSON 參數改以 `::text::jsonb` 傳入，初始化亦修復先前保存成 JSON 字串的訊息、事件及 run 欄位。
- 套用修正後，已有發言可正常恢復顯示。下一步遇到 `http://localhost:4201/ag-ui` 拒絕連線；現有保險 Bot 配置的 LangGraph 容器原本停止，已建置目前源碼並以原有模型環境載入。部署沒有保留已刪除檔案的舊 bind mount、舊工具回呼設定或健康檢查。
- 最後在正式入口選擇既有「保險 PDF 文案總監」，實際收到兩句香港繁體中文回覆，生成結束後介面恢復可輸入狀態。沒有自動重播失敗訊息或冒稱舊的失敗 run 成功。
- API、前端、PostgreSQL、supervisor、模型服務及該 Bot 的電腦保持運行。沒有重建未改動的前端，沒有執行測試、lint、typecheck 或另開子代理。

本次程式碼只修改 runtime 的匯入及 JSON 保存接線，文件同步記錄實際結果。Bot 名單實際仍包含「Your agent」及「OpenDuet」兩個舊項目，本次沒有擴大清理。這次對話未執行瀏覽器操作或 Bot 委派，不能據此宣稱這些流程均已運行成功。
