// 숫자 JSON 계약과 연결할 때 안전 범위를 확인하기 위해 앱 내부 ID는 불투명 문자열로 보관한다.
export type ChatRoomId = string;
export type ChatMessageId = string;
export type ChatRoomType = "DIRECT" | "GROUP" | "OPEN";
export type ChatSenderType = "USER" | "AI" | "SYSTEM";

export interface ChatRoom {
  id: ChatRoomId;
  roomType: ChatRoomType;
  sourceType: string;
  myRole?: "OWNER" | "ADMIN" | "MEMBER" | null;
  name: string | null;
  memberCount: number;
  unreadCount: number;
  updatedAt: string;
  active: boolean;
  closed?: boolean;
  partner: { userId: string; displayName: string } | null;
}

export interface ChatTranslation {
  id: string;
  languageCode: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  translatedContent: string | null;
  completedAt: string | null;
}

export interface ChatMessage {
  contentVisibility?: "VISIBLE" | "BLOCKED" | "MODERATED";
  authorDeleted?: boolean;
  id: ChatMessageId;
  chatRoomId: ChatRoomId;
  senderUserId: string | null;
  senderAiMemberId?: string | null;
  senderType: ChatSenderType;
  senderName: string | null;
  messageType: "TEXT" | "SYSTEM";
  content: string;
  status: "SENT" | "DELETED";
  unreadMemberCount: number | null;
  translations: ChatTranslation[];
  createdAt: string;
  updatedAt: string;
  sender: { openChatMemberId: string; nickname: string; memberCode: string; profileImageUrl?: string | null } | null;
}

export interface MessagePage {
  messages: ChatMessage[];
  nextCursorId: string | null;
  hasNext: boolean;
}

export interface ChatLanguageSettings {
  translationLanguageCode: string;
  showOriginal: boolean;
  showTranslation: boolean;
}

export interface OpenProfile {
  openChatMemberId: string;
  nickname: string;
  memberCode: string;
  joinedAt: string;
  profileImageUrl?: string | null;
}

export interface OpenRoom {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  maxMemberCount: number;
  joined: boolean;
  joinable: boolean;
  joinBlockedReason: string;
  myOpenProfile: OpenProfile | null;
}
