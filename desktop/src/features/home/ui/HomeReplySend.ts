import type { Channel } from "@/shared/api/types";
import { sendChannelMessage } from "@/shared/api/tauri";
import { splitOutgoingTags } from "@/features/messages/lib/imetaMediaMarkdown";
import { messageMentionPubkeys } from "@/features/messages/lib/messageMentionPubkeys";

type SendHomeInboxReplyInput = {
  channel: Channel | null | undefined;
  channelId: string;
  content: string;
  currentPubkey: string | null | undefined;
  mediaTags?: string[][];
  mentionPubkeys: string[];
  parentEventId?: string | null;
};

export async function sendHomeInboxReply({
  channel,
  channelId,
  content,
  currentPubkey,
  mediaTags,
  mentionPubkeys,
  parentEventId,
}: SendHomeInboxReplyInput) {
  const {
    mediaTags: imetaTags,
    emojiTags,
    mentionTags,
  } = splitOutgoingTags(mediaTags);
  const recipientPubkeys =
    channel && currentPubkey
      ? messageMentionPubkeys(channel, currentPubkey, mentionPubkeys)
      : mentionPubkeys;
  const result = await sendChannelMessage(
    channelId,
    content,
    parentEventId,
    imetaTags,
    recipientPubkeys,
    undefined,
    emojiTags,
    mentionTags,
  );
  return { result, imetaTags, emojiTags, mentionTags };
}
