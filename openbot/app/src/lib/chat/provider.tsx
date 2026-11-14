import { useEffect, type ReactNode } from "react";
import { ActiveBotProvider } from "./active-bot";
import { galleryManifest } from "./gallery-registry";
import { announceGallery } from "@/lib/components/queries";
import { useQuery } from "@tanstack/react-query";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { SelectedBotProvider } from "@/lib/agents/selected-bot";
export function ChatProvider({ children }: { children: ReactNode }) {
  const { data: person } = useQuery(currentUserQueryOptions());
  useEffect(() => { void announceGallery(galleryManifest()); }, []);
  if (!person) return null;
  return <SelectedBotProvider key={person.id} userId={person.id}><ActiveBotProvider>{children}</ActiveBotProvider></SelectedBotProvider>;
}
