# PDSDuet — AI Assistant for Insurance Brokers

**Turn an insurance proposal PDF into clear selling points and client conversation scripts, written in Hong Kong Traditional Chinese.**

**One agent across phones and computers, with synced conversations and progress and access for multiple authorised users.**

PDSDuet is an independently maintained AI workstation with a focused sales-preparation workflow for insurance brokers. A broker uploads a product brochure or proposal from a phone or computer; the assistant reads the document and drafts material the broker can use when explaining the plan to a customer.

Development continues in [personadynamics-studio/PDSDuet](https://github.com/personadynamics-studio/PDSDuet), with a fresh Git history beginning from the existing PDSDuet code and modifications. Future features and architecture are maintained independently of OpenDuet.

**Project status:** Personal MVP in active development. The insurance-broker application changes are included here; the latest mobile recovery and interface changes await deployment.

## The problem it addresses

Insurance proposals contain long benefit descriptions, payment schedules and illustration tables. A broker needs to turn that material into an understandable customer conversation. PDSDuet focuses on that step: explaining a product's selling points and giving the broker usable wording, with figures tied to the uploaded document.

## How a broker uses it

1. Open the web interface on a phone or computer.
2. Upload an insurance proposal or product brochure as a PDF.
3. Receive document-specific selling points, key figures and suggested client conversation scripts.
4. Use the draft to prepare a client discussion or presentation.

The output is prepared **for the broker to use with customers**. The phone provides the interface, while the host computer manages the agent workflow and conversation state. GPT inference is accessed through a configured model API.

## Cross-device use and shared access

- **Phone and desktop, one agent:** Open the agent's web interface on either device and continue with the same conversations and uploaded documents.
- **Synced progress:** Conversation history and task state are managed by the backend, so devices can retrieve progress when they reconnect.
- **Host-managed work:** The phone sends documents and requests; the host manages the agent workflow. Document-processing runs continue independently of the phone's screen or connection.
- **Multiple authorised users:** Several people can connect from their own phones or computers to the same deployment through Tailscale. The current MVP uses a shared application identity, with access controlled through Tailscale.

## PDSDuet features

| Area | Work in PDSDuet |
| --- | --- |
| Insurance workflow | A dedicated PDF-to-sales-material use case, with broker-facing drafts in Hong Kong Traditional Chinese. The deployment's specific agent instructions remain private. |
| Original PDF input | Browser and iPhone PDF selection, upload handling and original-file input through the agent runtime to OpenAI. |
| Mobile conversation recovery | Code changes to reconcile durable history, restore progress after reconnecting and isolate replaced streaming connections. |
| Readable replies | Complete-message bubbles and explicit completion of streamed Markdown rendering. |
| Hong Kong interface | Localised navigation, conversation controls, attachment handling, settings and administration text. |
| Cross-device use | Phone and desktop browsers connect to the same agent, conversations and backend-managed progress. |
| Shared access | Multiple authorised people can access the same self-hosted deployment through Tailscale. |

## Technical approach

- **Web interface:** React, TypeScript and TanStack.
- **Application and agent runtime:** Bun, the OpenBot/CopilotKit platform and LangGraph integration.
- **Document understanding:** Original PDF input to an OpenAI model, including document pages rather than a text-only extraction.
- **Remote access:** Tailscale connects a phone browser to the self-hosted application.

The current insurance workflow focuses on uploaded documents. General-purpose features inherited from OpenDuet, such as email onboarding and web research, are outside this MVP's core use case.

PDF and Markdown/text uploads allow **20 MiB per file**. PDFs reach the model as original files; Markdown/text files are stored whole, with the first 120,000 characters sent to the model and a partial-read warning shown for large text attachments. A run can include up to 32 MiB of attachment data in total.

## 中文簡介

**PDSDuet 是供保險經紀使用的 AI 助理：把保險計劃書或產品小冊子 PDF，整理成香港繁體中文的產品賣點、重點數字及客戶溝通話術，支援電腦與手機同步使用，並允許多人接入。**

經紀可以在手機或電腦上載 PDF，取得用於準備客戶面談及產品介紹的初稿。手機負責上載、傳送及顯示訊息；主機負責管理代理工作流程，再透過模型 API 處理文件。

同一個 agent 可在電腦及手機之間接續使用，共用對話、文件及工作進度。處理文件的工作由主機管理，手機熄屏或斷線後，重新連接即可取回進度；多位獲授權人士亦可從各自裝置接入同一部署。目前 MVP 採共用應用身分，接入由 Tailscale 管理。

這個專案的重點，是將通用代理平台改造成貼近保險經紀工作場景的工具，包括原生 PDF 傳遞、跨裝置使用、多人接入、對話進度恢復、完整回覆排版及香港中文介面。

## Public code and private deployment

This public repository contains the application changes and documentation. Deployment-specific agent instructions, API keys, OAuth credentials, customer documents and conversation data are kept outside the public commits. Running the insurance workflow requires configuring your own agent and model credentials.

For platform setup and architecture, see the local [deployment guide](openbot/docs/deployment.md), [architecture guide](openbot/docs/architecture.md) and [configuration reference](openbot/docs/configuration.md).

## Attribution and licence

PDSDuet originated as an adaptation of [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet), built on OpenBot and CopilotKit, and is now maintained as an independent project. The original copyright and MIT licence are retained. PDSDuet development focuses on the insurance document workflow and the application changes described above.

[MIT licence](LICENSE).
