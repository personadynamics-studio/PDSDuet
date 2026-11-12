import {
  IconBook,
  IconBriefcase,
  IconCalendar,
  IconCar,
  IconChartBar,
  IconCube,
  IconCurrencyDollar,
  IconFolder,
  IconGift,
  IconHeart,
  IconHome,
  IconMail,
  IconMapPin,
  IconMusic,
  IconPencil,
  IconPlane,
  IconSearch,
  IconSeedling,
  IconShoppingBag,
  IconSquareCheck,
  IconToolsKitchen2,
  IconUsers,
  IconVideo,
  IconWorld,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ChannelColour, ChannelIcon } from "@/lib/duet-channels/queries";
import { cn } from "@/lib/utils";

/*
 * How a channel is drawn: one of 24 line icons, stroked in its colour. The names come from
 * shared/channel-look.ts, which the server stores and checks; what each name draws is decided here.
 */

/** The glyph for each icon name, all line icons on one stroke weight. */
export const CHANNEL_GLYPHS: Record<ChannelIcon, TablerIcon> = {
  check: IconSquareCheck,
  calendar: IconCalendar,
  mail: IconMail,
  dollar: IconCurrencyDollar,
  chart: IconChartBar,
  globe: IconWorld,
  pin: IconMapPin,
  home: IconHome,
  cube: IconCube,
  video: IconVideo,
  folder: IconFolder,
  pencil: IconPencil,
  search: IconSearch,
  heart: IconHeart,
  people: IconUsers,
  briefcase: IconBriefcase,
  book: IconBook,
  plane: IconPlane,
  car: IconCar,
  food: IconToolsKitchen2,
  bag: IconShoppingBag,
  gift: IconGift,
  sprout: IconSeedling,
  music: IconMusic,
};

/** What each icon name is called, for a screen reader and the grid's radios. */
export const CHANNEL_ICON_LABELS: Record<ChannelIcon, string> = {
  check: "清單",
  calendar: "日曆",
  mail: "電郵",
  dollar: "金錢",
  chart: "圖表",
  globe: "地球",
  pin: "地點",
  home: "家居",
  cube: "盒子",
  video: "影片",
  folder: "資料夾",
  pencil: "鉛筆",
  search: "搜尋",
  heart: "愛心",
  people: "成員",
  briefcase: "公事包",
  book: "書本",
  plane: "飛機",
  car: "汽車",
  food: "餐飲",
  bag: "購物",
  gift: "禮物",
  sprout: "幼苗",
  music: "音樂",
};

/** What each colour is called, for the dots' names. */
export const CHANNEL_COLOUR_LABELS: Record<ChannelColour, string> = {
  berry: "莓紅色",
  blush: "粉紅色",
  peach: "桃色",
  amber: "琥珀色",
  sage: "灰綠色",
  green: "綠色",
  sky: "天藍色",
  blue: "藍色",
  lavender: "薰衣草紫色",
};

/** The colour's CSS value, from the theme's tokens, so light and dark each get their own. */
export function channelColour(colour: ChannelColour): string {
  return `var(--duet-ch-${colour})`;
}

/** A channel's icon, stroked in its colour. Decorative: the name beside it says which channel. */
export function ChannelGlyph({
  icon,
  colour,
  size = 24,
  stroke = 1.9,
  className,
}: {
  icon: ChannelIcon;
  colour: ChannelColour;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const Glyph = CHANNEL_GLYPHS[icon];
  return (
    <span
      aria-hidden
      className={cn("inline-grid shrink-0 place-items-center", className)}
      data-channel-colour={colour}
      data-channel-icon={icon}
      style={{ color: channelColour(colour), width: size, height: size }}
    >
      <Glyph size={size} stroke={stroke} />
    </span>
  );
}

/**
 * The tag a task wears for the channel it was asked for in: its icon and its name, both in the
 * channel's colour. Nothing for a task asked for in Everything.
 */
export function ChannelTag({
  channel,
  className,
}: {
  channel: { name: string; icon: ChannelIcon; colour: ChannelColour } | null;
  className?: string;
}) {
  if (!channel) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium text-[13px] leading-4",
        className,
      )}
      data-channel-tag={channel.colour}
      style={{ color: channelColour(channel.colour) }}
    >
      <ChannelGlyph
        colour={channel.colour}
        icon={channel.icon}
        size={12}
        stroke={2.2}
      />
      <span className="truncate">{channel.name}</span>
    </span>
  );
}
