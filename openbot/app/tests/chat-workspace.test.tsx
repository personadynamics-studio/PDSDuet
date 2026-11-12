import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { ChatWorkspace } from "@/components/shell/chat-workspace";
import { settleReactWork } from "./settle-react-work";

let originalFetch: typeof fetch;
let originalMatchMedia: typeof window.matchMedia;
let resize: ((event: MediaQueryListEvent) => void) | undefined;
let requests: { path: string; method: string }[] = [];

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3010" });
  originalFetch = globalThis.fetch;
  originalMatchMedia = window.matchMedia;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  resize = undefined;
  requests = [];
});
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

function viewport(desktop: boolean) {
  window.matchMedia = ((query: string) => {
    if (query !== "(min-width: 1024px)")
      return originalMatchMedia.call(window, query);
    return {
      matches: desktop,
      media: query,
      addEventListener: (_type: string, listener: typeof resize) => {
        resize = listener;
      },
      removeEventListener: () => {
        resize = undefined;
      },
    };
  }) as typeof window.matchMedia;
  // A completely local backend double: no model, runtime or real computer requests leave this test.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (path.endsWith("/control"))
        return Response.json({
          holder: "bot",
          since: "2026-11-08T00:00:00Z",
          requested: false,
          transitioning: false,
          recoveryRequired: false,
          resumeSnapshotRequired: false,
        });
      if (path.endsWith("/screenshot"))
        return Response.json({
          base64: "AA==",
          width: 1280,
          height: 800,
          url: "about:blank",
        });
      return Response.json({ agents: [] });
    },
    { preconnect: () => {} },
  ) as typeof fetch;
}

const bot = { id: "desktop-layout-test", name: "OpenDuet" };
function draw(
  available: typeof bot | null = bot,
  mounted: () => void = () => {},
) {
  function Conversation() {
    useEffect(mounted, []);
    return (
      <textarea
        aria-label="Existing draft"
        defaultValue="Keep my current conversation"
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ChatWorkspace bot={available}>
        {(computerAction) => (
          <>
            <header>{computerAction}</header>
            <Conversation />
          </>
        )}
      </ChatWorkspace>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

test("desktop opens the Bot computer beside the existing conversation by default", async () => {
  viewport(true);
  const view = draw();
  expect(
    await view.findByRole("region", { name: "Computer sidebar" }),
  ).toBeTruthy();
  expect(view.getByText("電腦")).toBeTruthy();
  expect(
    (view.getByRole("textbox", { hidden: true }) as HTMLTextAreaElement).value,
  ).toBe("Keep my current conversation");
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  view.client.clear();
});

test("mobile starts closed, opens explicitly and closes without losing the draft", async () => {
  viewport(false);
  const view = draw();
  const draft = view.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: "Unsaved text" } });
  expect(view.queryByRole("region", { name: "Computer sidebar" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Open Computer" }));
  expect(
    await view.findByRole("region", { name: "Computer sidebar" }),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "Computer sidebar" })).toBeNull(),
  );
  expect(view.getByRole("textbox")).toBe(draft);
  expect(draft.value).toBe("Unsaved text");
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  view.client.clear();
});

test("crossing the desktop breakpoint changes only the panel, not the conversation", async () => {
  viewport(true);
  let mounts = 0;
  const view = draw(bot, () => {
    mounts += 1;
  });
  const draft = view.getByRole("textbox", { hidden: true });
  await act(async () => resize?.({ matches: false } as MediaQueryListEvent));
  await waitFor(() =>
    expect(view.queryByRole("region", { name: "Computer sidebar" })).toBeNull(),
  );
  await act(async () => resize?.({ matches: true } as MediaQueryListEvent));
  expect(
    await view.findByRole("region", { name: "Computer sidebar" }),
  ).toBeTruthy();
  expect(view.getByRole("textbox", { hidden: true })).toBe(draft);
  expect(mounts).toBe(1);
  view.client.clear();
});

test("without a primary Bot the computer entry is disabled and no panel is mounted", () => {
  viewport(true);
  const view = draw(null);
  expect(
    view
      .getByRole("button", { name: "Open Computer" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(view.queryByRole("region", { name: "Computer sidebar" })).toBeNull();
  view.client.clear();
});
