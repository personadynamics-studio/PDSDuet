import type { Page } from "playwright";
import type { BrowserRuntime } from "./browser-runtime";
import { parseNavigateUrl } from "./request-validation";

type Backend = BrowserRuntime["backend"];
export type PagePurpose = "read" | "navigate";

/** Navigation can leave an unreadable Chrome error/local page, but cannot inspect it. */
export function assertPageAccess(
  backend: Backend,
  url: string,
  purpose: PagePurpose = "read",
): void {
  if (purpose === "navigate") return;
  if (
    backend === "local-chrome" &&
    url !== "about:blank" &&
    !/^https?:\/\//i.test(url)
  ) {
    throw new Error(
      "Local Chrome computer tools can access only web pages. Use the approved host-access tools for local files.",
    );
  }
}

export async function navigateWebPage(
  page: Pick<Page, "goto" | "url">,
  url: string,
  backend: Backend,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const parsed = parseNavigateUrl(url);
  if (!parsed.ok) throw new Error(parsed.error);
  const response = await page.goto(parsed.url, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
    signal,
  });
  assertPageAccess(backend, page.url());
  return response;
}
