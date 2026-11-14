import { createFileRoute } from "@tanstack/react-router";
import { ChannelScreen } from "@/components/shell/channel-screen";

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  component: () => <ChannelScreen channelId={Route.useParams().channelId} />,
});
