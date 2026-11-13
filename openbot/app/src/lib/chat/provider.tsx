import { useEffect, type ReactNode } from "react";
import { ActiveBotProvider } from "./active-bot";
import { galleryManifest } from "./gallery-registry";
import { announceGallery } from "@/lib/components/queries";
export function ChatProvider({ children }: { children: ReactNode }) {
  useEffect(() => { void announceGallery(galleryManifest()); }, []);
  return <ActiveBotProvider>{children}</ActiveBotProvider>;
}
