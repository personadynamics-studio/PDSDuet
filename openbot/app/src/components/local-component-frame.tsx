import { useMemo } from "react";
export function LocalComponentFrame({ html, css = "", js = "", args = {}, title = "元件預覽" }: { html: string; css?: string; js?: string; args?: Record<string, unknown>; title?: string }) {
  const document = useMemo(() => {
    const script = `window.__args = ${JSON.stringify(args)};\n${js}`.replace(/<\/script/gi, "<\\/script");
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src data:; connect-src 'none'; form-action 'none'"><style>html,body{margin:0;font-family:system-ui}body{padding:12px;box-sizing:border-box}${css.replace(/<\/style/gi, "<\\/style")}</style></head><body>${html}<script>${script}</script></body></html>`;
  }, [html, css, js, args]);
  return <iframe title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} className="min-h-64 w-full border-0" />;
}
