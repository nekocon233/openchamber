import React from 'react';
import { useOpenChatLink } from '@/components/chat/useOpenChatLink';

export const ChatPrLinkProbe: React.FC<{ directory: string; url: string }> = ({ directory, url }) => {
  const open = useOpenChatLink(directory);
  return <button type="button" data-chat-pr-link onClick={() => open(url)}>Chat PR</button>;
};
