<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/banner.png">
  <img src="assets/banner.png" alt="PDSDuet — 每個 AI 都有自己的電腦，手機就是你的隨身員工" width="100%">
</picture>

<br>

### 每個 AI 都有自己的電腦，手機就是你的隨身員工

Your mobile AI employee, backed by its own persistent computer — built for insurance brokers first, simple enough for anyone to use daily.

<p>
  <a href="#繁體中文介紹"><strong>繁體中文</strong></a> ·
  <a href="#english"><strong>English</strong></a> ·
  <a href="#快速部署--quick-start">快速部署 / Quick Start</a> ·
  <a href="#架構與安全設計--architecture">架構與規格 / Architecture</a>
</p>

<p>
  <img src="https://img.shields.io/badge/license-MIT-522591?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/self--hosted-Docker_%2B_Bun_%2B_PostgreSQL-1f2328?style=flat-square" alt="Self-Hosted Stack">
  <img src="https://img.shields.io/badge/AI_Computer-Playwright_Chromium-0f766e?style=flat-square" alt="Playwright Chromium">
  <img src="https://img.shields.io/badge/language-香港繁體中文_%7C_EN-2563eb?style=flat-square" alt="Hong Kong Traditional Chinese and English">
</p>

</div>

<br>

<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/showcase-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/showcase.png">
  <img src="assets/showcase.png" alt="PDSDuet 三大核心能力：手機隨身員工、AI 專屬電腦、保險與日常自主代理人" width="100%">
</picture>
<br>
<sub>手機打開隨時派工 · 每位員工有獨立電腦與瀏覽器 · 保險專精開箱亦支援自建角色與團隊共用</sub>
</div>

---

<a id="繁體中文介紹"></a>

## 繁體中文介紹

### 為甚麼寫 PDSDuet？

保險從業員日常最花精神的，往往不是專業判斷，而是**趕著見客前，要把幾十頁保司計劃書拆成客人聽得明的重點與講法**；或者在外出途中，臨時要查公開條款、對數字、整理跟進草稿。

一般對話式 AI 每次換裝置都要重頭交代、開不了真實網頁查原文，手機一鎖屏長任務就斷。**PDSDuet** 把主機上的 **AI 專屬電腦**、手機裡的**隨身 AI 員工**與可分工的**自主代理人**放進同一個工作台：你在外面用手機打開網頁丟入計劃書 PDF 或指派任務，主機在後方繼續跑；回到電腦前打開同一條對話，進度、檔案與瀏覽器登入狀態全部接得上。

---

### 三個核心能力

<table>
<tr>
<td width="33.3%" valign="top">

#### 📱 手機隨身員工 · 打開就叫得動
- **手機電腦同一條對話**：經 Tailscale 安全連回主機，出街途中在手機下達的工作，回辦公室用電腦直接接著檢視結果。
- **主機扛起繁重運算**：手機只負責上傳計劃書與下達要求，實際閱讀文件與操作網頁全部在你的主機執行。
- **鎖屏斷線不掉進度**：對話紀錄與執行狀態由主機 PostgreSQL 管理，切出畫面或重新連線後自動接回實時進度。

</td>
<td width="33.3%" valign="top">

#### 🖥️ AI 專屬電腦 · 每位員工一台機
- **獨立瀏覽器與工作區**：每個代理人自帶專屬 Chromium 瀏覽器（保留網站登入狀態）及隔離工作區 `/workspace`，支援讀寫檔案與 Shell 指令。
- **實時看到電腦畫面**：對話旁邊隨時展開「電腦畫面」，清楚看見這位員工正在開哪個網頁、查到哪裡。
- **安全接手登入**：遇到網站需要輸入密碼或驗證碼時自動暫停；密碼透過加密遮罩直接送入網頁，代理人永不接觸密碼，登入完交還控制權即繼續。

</td>
<td width="33.3%" valign="top">

#### 🤝 自主代理人 · 保險專精、日常萬用
- **開箱即用雙員工**：內建「保險 PDF 文案總監」與「搜索機器人」，不用自己從零寫設定。
- **員工之間直接協作**：主代理人可主動委派其他代理人查資料，過程收起成可展開的協作紀錄，最後整理成完整回覆交給你。
- **自建角色與群聊**：隨時新增任何專長的新員工，亦可開一個群聊讓多位代理人同場各自回應。

</td>
</tr>
</table>

---

### 保險從業者的 5 分鐘日常

1. **在手機或電腦選取員工，直接丟入 PDF 原檔**
   上載保司產品小冊子或建議書（單檔最高 **20 MiB**，單輪總附件上限 **32 MiB**）。系統會將原始 PDF 直接傳給模型閱讀頁面與數字，而不是粗糙抽取純文字。
2. **取得可直接見客的香港繁體中文成稿**
   預設的**保險 PDF 文案總監**會依實際文件產出：
   - **產品一句話定位**
   - **3 至 4 個不重複的核心賣點**（由客戶實際財務痛點切入到具體保障或回報數字）
   - **可直接說出口的示範話術**（得體自然的香港書面繁體中文，不寫空洞口號，亦不在結尾追問客套話）
   - **2 條客戶常見問題與正面解答**
3. **要查保監局、稅務或醫療公開資料，交給搜索機器人**
   **搜索機器人**會用瀏覽器固定分頁開啟 Google AI 模式查詢，把完整回答與來源連結原文直傳給你，不做擅自改寫或刪節。
4. **遇到需要登入保司系統或網頁查核，點一下接手**
   展開「電腦畫面」，自己輸入帳號密碼完成驗證後按「我已登入」，AI 員工就會接著完成餘下步驟。

---

### 普通人也能拿來做甚麼？

你不做保險，一樣可以把 PDSDuet 當成養在自己主機上的「隨身數碼員工」：

- **寫一段職責說明就多一位專屬員工**：新增代理人時只需填寫名稱與職責（支援直接調用 OpenAI / Anthropic，或接駁你自己的 AG-UI / LangGraph 服務），就能變成旅遊比價、租約／合約細則梳理、技術研究或書信寫作助手。
- **有電腦可用，不只是純聊天**：讓它替你開網頁讀資料、用工作區 `/workspace` 處理文件與腳本，亦可以把整理好的報告存成**已保存頁面**隨時查閱。
- **按意願串接個人工具**：在「應用程式連接」授權接上 **Gmail、Google Drive、Google Calendar 或 Notion**，寄信等外部動作由你親自批核。
- **一人私用，或團隊共用同一主機**：支援 Google、Microsoft、Okta 帳號登入，沿用管理員與一般用戶權限，各人對話與授權分開管理；亦支援單人模式本機啟動。

---

<a id="english"></a>

## English

**PDSDuet** gives every AI agent its own computer and puts that team in your pocket. Built first around an **insurance broker's** daily workflow, and straightforward enough for anyone who wants reliable, self-hosted digital coworkers accessible from both phone and desktop.

### Why it feels different from a standard chat box

| Pillar | What actually happens |
| --- | --- |
| **A Mobile Employee** | Open the web app on your phone over Tailscale, drop in a proposal PDF, or assign a task on the move. Your host machine does the heavy lifting — locking your phone or switching to your desk browser never interrupts the run, and reconnecting picks up the live stream cleanly. |
| **Each AI Has Its Own Computer** | Every Bot gets a persistent Chromium profile, its own sign-in state, shell, and isolated `/workspace`. Open **Live Screen** beside the chat to watch it work, or step in when a portal asks for login or 2FA — credentials typed into the masked prompt go straight to the browser and never enter the model's transcript. |
| **Built for Insurance, Open to Everyday Work** | Ships with two default Bots in [agents.yaml](openbot/examples/openduet/agents.yaml): **保險 PDF 文案總監** (reads uploaded PDFs natively into Hong Kong Traditional Chinese selling points, grounded numbers, scripts, and Q&A) and **搜索機器人** (returns verbatim Google AI Mode answers with source links). Add your own roles, let Bots delegate to one another (`message_bot`), run group chats, or connect Gmail, Google Drive, Calendar, and Notion with per-user approval. |

### Built for insurance brokers, open to everyday workflows

- **For insurance agents:** Upload a product brochure or benefit illustration PDF (up to **20 MiB** per file; sent to the model as an original PDF rather than naive text scraping) from your phone or laptop and walk into your meeting with verified figures, plain positioning, scripts, and objection handling.
- **For everyday users:** Add any Bot role in plain words. Use it as a web researcher that keeps its own browser tabs, saves curated pages, edits files inside `/workspace`, or handles email and document lookups under explicit per-action approval.
- **For solo or small teams:** Start in single-user mode on one machine, or enable **Google / Microsoft / Okta** sign-in so colleagues or family members share one self-hosted host while keeping conversations and app grants separate.

---

<a id="快速部署--quick-start"></a>

## 快速部署 / Quick Start

### 1. 環境需求 / Prerequisites

- **Docker**（含 Docker Compose）
- **Bun** `1.3+`
- `openssl`、`curl`、`lsof`
- 你自己的模型 API Key（例如 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`）

### 2. 安裝與啟動 / Configure & Run

```sh
git clone https://github.com/personadynamics-studio/PDSDuet.git
cd PDSDuet
cp openbot/.env.example openbot/.env
```

編輯 `openbot/.env`，至少填入你的模型金鑰（例如 `OPENAI_API_KEY`），再啟動完整服務（Edit `openbot/.env` with your model key, then start the stack）：

```sh
bun install
bash scripts/start.sh
```

啟動完成後打開瀏覽器（Once running, open in your browser）：
- **Web 介面 / App**：`http://localhost:3010`
- **API 服務 / Server**：`http://localhost:3001`

停止服務（加上 `--keep-computers` 可保留各代理人的瀏覽器登入狀態 / pass `--keep-computers` to preserve browser logins）：

```sh
bash scripts/stop.sh --keep-computers
```

### 3. 手機安全接入與多人登入 / Phone Access & Multi-User Sign-In (Tailscale + OAuth)

`openbot/.env.example` 預設啟用 `OPENBOT_SINGLE_USER=true`，僅在本機位址（`127.0.0.1` / `::1`）監聽，方便單機試用。若要從手機經 Tailscale 連線，或開放給團隊以 Google / Microsoft / Okta 登入（Remove `OPENBOT_SINGLE_USER` before exposing beyond localhost）：

1. 從 `openbot/.env` 移除 `OPENBOT_SINGLE_USER=true`。
2. 產生正式金鑰並設定 `KEY_ENCRYPTION_KEY` 與 `BETTER_AUTH_SECRET`（各 32 bytes：`openssl rand -base64 32`）。
3. 設定 OAuth Provider（如 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`、`INITIAL_ADMIN_EMAILS`）及 `BETTER_AUTH_URL`、`OPENBOT_PUBLIC_URL`、`TRUSTED_ORIGINS`。
4. 參考 [scripts/tailscale-serve.json](scripts/tailscale-serve.json) 將 Tailscale HTTPS 流量轉發至 `http://127.0.0.1:3010`。

---

<a id="架構與安全設計--architecture"></a>

## 架構與安全設計 / Architecture & Specs

| 層面 Area | 實際規格 Implementation |
| --- | --- |
| **前端介面 Web App** | React、TypeScript、TanStack Router / Query，香港繁體中文介面，支援深淺色模式、手機操作排版與 SSE 斷線續傳。 |
| **執行與結算 Core Runtime** | Bun + 本地 PostgreSQL；聊天、群聊與 Bot 委派共用單一執行入口與結算模組（[architecture.md](openbot/docs/architecture.md)）。 |
| **AI 電腦 Browser & Files** | Playwright + Chromium 沙盒電腦，支援每 Bot 獨立容器（`supervisor`）或共用容器分資料夾隔離，含實時螢幕與接手控制。 |
| **檔案與上下文 Limits** | 單檔上傳上限 **20 MiB**（PDF 原檔送交模型；Markdown / 純文字保存全文並傳送前 120,000 字元），單輪附件上限 **32 MiB**；非 PDF 內容採 `o200k_base` 300,000 tokens 應用層預算。 |
| **私密與公開邊界 Privacy** | 公開倉庫僅含程式碼、文件及兩個預設角色定義（[agents.yaml](openbot/examples/openduet/agents.yaml)）；API 金鑰、OAuth 憑證、瀏覽器設定檔、客戶計劃書及對話資料均保留在你的本地部署環境。 |

> [!NOTE]
> **目前核心版本說明（2026-11-14）**：目前抽離後的核心整合了對話、瀏覽器操作、原檔 PDF 閱讀、Bot 委派協作與群聊於同一執行迴圈；舊版背景排程（Routines / Morning Brief）及外部執行佇列已移除，不提供自動每日排程執行。詳細架構與運作紀錄請見 [openbot/docs/architecture.md](openbot/docs/architecture.md)。

### 延伸閱讀 / Documentation

- [架構說明 Architecture](openbot/docs/architecture.md) — 執行生命週期、Bot 身份與協作隔離、瀏覽器接手與 SSE 機制
- [部署指南 Deployment](openbot/docs/deployment.md) — 容器映像、嵌入式與外部 PostgreSQL、記憶體建議與暫存清理
- [設定參考 Configuration](openbot/docs/configuration.md) — 環境變數與租戶 YAML 套件設定
- [代理人設定 Coworkers](openbot/docs/coworkers.md) — 角色描述、頻道、可見性與外部 AG-UI 註冊
- [文件總覽 Docs Index](openbot/docs/README.md) — 包含 Google Workspace、Google Drive、Notion 與研究工具說明

---

## 版權與來源 / Attribution & Licence

PDSDuet 基於 [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) 與 OpenBot 演進並獨立維護，保留原有版權聲明與 [MIT Licence](LICENSE)。
